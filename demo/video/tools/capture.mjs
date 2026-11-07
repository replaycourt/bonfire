#!/usr/bin/env node
// Records the take for the demo video: a fresh visitor plays Bonfire through its own page in headless
// Chrome, on the real contract, while the DevTools screencast records the screen. Nothing is mocked:
// every click is a real input event on the page, and every number on screen comes from NEAR testnet.
// The demo bots play the same nights from scripts/bots.mjs (run separately, see README.md).
//
//   node demo/video/tools/capture.mjs --out <take dir> --night <A> [--smoke-night <A+1>] [--face-after <night>]
//        [--first 100] [--second 25] [--profile <dir>] [--scale 1.5] [--port 9411] [--serve-port 8791] [--dry]
//
// The script, in the page's own words:
//   night A        open the page a few seconds after dusk, "Get kindling", hover a throw button so the
//                  hint shows what the wood counts, throw --first EMBER, then watch the night
//   dawn of A      the banner; "Collect"
//   night A+1      throw --second EMBER (the under-throw of the smoky night), watch it
//   dawn of A+1    the banner
//   --face-after   once that night has settled: scroll to the coin's face, back up, open "Proof"
//
// With --tour (the short cut) it records a fresh visitor's first minute instead: the replay of last
// night, "Proof" and its "Try to cheat it" (one throw on tomorrow's fire, refused; --dry only points
// at the button), then the supply chart. --night is optional there (then it opens at once).
//
// Writes into <take dir>:
//   frames/f000001.jpg …   the screencast (1280x720 CSS pixels at --scale)
//   frames.jsonl           one line per saved frame: {"i": n, "t": <seconds, wall clock>}
//   events.jsonl           what happened and when: clicks, cursor moves, throws (named), pile, banners, toasts
//   take.json              a summary: the visitor's account, its transactions, the nights seen
//   icon.svg, keys.json    the coin's face and view_access_key_list, read when the face is shown
// Between the smoky night's dawn and the face only two frames a second are kept (nothing is cut from them).
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchChrome, Page, sleep } from './cdp.mjs'
import { serve } from './serve.mjs'
import { DEPLOYMENTS, RPC_HOSTS } from '../../../web/js/config.js'

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : dflt
}
const flag = (name) => process.argv.includes(`--${name}`)
const OUT = resolve(arg('out', 'take'))
const PROFILE = resolve(arg('profile', join(OUT, 'profile')))
const NIGHT = Number(arg('night', 0))
const SMOKE_NIGHT = Number(arg('smoke-night', NIGHT + 1))
const FACE_AFTER = Number(arg('face-after', SMOKE_NIGHT))
const FIRST = arg('first', '100')
const SECOND = arg('second', '25')
const PORT = Number(arg('port', 9411))
const SERVE_PORT = Number(arg('serve-port', 8791))
const SCALE = Number(arg('scale', 1.5))
const OPEN_AFTER = Number(arg('open-after', 6)) // seconds after dusk
const DRY = flag('dry')
const TOUR = flag('tour')
const QUALITY = Number(arg('quality', 88))
const W = 1280
const H = 720
const D = DEPLOYMENTS.final
const CONTRACT = D.contract
const LABELS = D.bots

mkdirSync(join(OUT, 'frames'), { recursive: true })
const eventsOut = createWriteStream(join(OUT, 'events.jsonl'))
const framesOut = createWriteStream(join(OUT, 'frames.jsonl'))
const now = () => Date.now() / 1000
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
function mark(ev, data = {}) {
  const e = { t: now(), ev, ...data }
  eventsOut.write(JSON.stringify(e) + '\n')
  if (ev !== 'cursor' && ev !== 'tick') log(ev, JSON.stringify(data).slice(0, 160))
  return e
}

// ---- the chain, read directly (for timing and for naming throws) ---------------------------------

async function rpc(params) {
  let last
  for (const host of [...RPC_HOSTS, ...RPC_HOSTS]) {
    try {
      const r = await fetch(host, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params }), signal: AbortSignal.timeout(8000) })
      const j = await r.json()
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200))
      return j.result
    } catch (e) {
      last = e
      await sleep(400)
    }
  }
  throw last
}
const view = async (method, args = {}) => JSON.parse(Buffer.from((await rpc({ request_type: 'call_function', finality: 'optimistic', account_id: CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') })).result).toString())
const ember = (u) => Number(BigInt(u) / 10n ** 14n) / 10_000

// ---- the page -----------------------------------------------------------------------------------

let cursor = { x: W * 0.55, y: H * 0.5 }
async function moveTo(page, x, y, ms = 420) {
  const from = { ...cursor }
  const steps = Math.max(6, Math.round(ms / 25))
  for (let i = 1; i <= steps; i++) {
    const k = i / steps
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2 // ease in-out
    cursor = { x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e }
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cursor.x, y: cursor.y })
    mark('cursor', { x: Math.round(cursor.x), y: Math.round(cursor.y) })
    await sleep(ms / steps)
  }
}

async function boxOf(page, selector) {
  return page.eval((sel) => {
    const el = typeof sel === 'string' ? document.querySelector(sel) : null
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
  }, selector)
}

async function hover(page, selector, label) {
  const box = await boxOf(page, selector)
  if (!box || box.w === 0) throw new Error(`no visible element ${selector}`)
  const x = box.x + (Math.random() - 0.5) * Math.min(10, box.w / 4)
  const y = box.y + (Math.random() - 0.5) * Math.min(6, box.h / 4)
  await moveTo(page, x, y)
  mark('hover', { what: label, x: Math.round(x), y: Math.round(y) })
  return { x, y }
}

async function click(page, selector, label = selector) {
  const { x, y } = await hover(page, selector, label)
  await sleep(160)
  mark('click', { x: Math.round(x), y: Math.round(y), what: label })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await sleep(70)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(60)
}

/** Scrolls with wheel events, like a hand on a trackpad, until the element's top is at `top` px. */
async function wheelTo(page, selector, top, label) {
  mark('scroll-start', { what: label })
  for (let i = 0; i < 80; i++) {
    const r = await page.eval((sel) => document.querySelector(sel)?.getBoundingClientRect().top ?? null, selector)
    if (r === null) break
    const d = r - top
    if (Math.abs(d) < 6) break
    const step = Math.sign(d) * Math.min(Math.abs(d), 60)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cursor.x, y: cursor.y, deltaX: 0, deltaY: step })
    await sleep(28)
  }
  await sleep(400)
  mark('scroll-end', { what: label, y: await page.eval(() => Math.round(scrollY)) })
}

// ---- what the page shows, read 5 times a second ---------------------------------------------------

const snapshot = () => {
  const $ = (id) => document.getElementById(id)
  const txt = (id) => $(id)?.textContent ?? null
  const shown = (id) => !!$(id) && !$(id).hidden
  return {
    live: document.body.classList.contains('live'),
    night: txt('night-label'),
    countdown: txt('countdown'),
    pile: txt('pile-num'),
    target: txt('target-num'),
    need: txt('need-big'),
    throwers: txt('throwers'),
    streak: txt('streak'),
    firestarter: txt('firestarter'),
    lastLog: txt('last-log'),
    early: txt('early'),
    balance: txt('balance'),
    myWood: txt('my-wood'),
    myShare: txt('my-share'),
    kindle: shown('btn-kindle'),
    chips: [...document.querySelectorAll('#throw-row button')].map((b) => `${b.querySelector('b')?.textContent}${b.disabled ? '(off)' : ''}`).join(' '),
    hint: txt('throw-hint'),
    ready: shown('ready') ? `${txt('ready-amount')} ${txt('ready-text')}` : null,
    banner: shown('banner') ? { kicker: txt('banner-kicker'), title: txt('banner-title'), text: txt('banner-text'), names: txt('banner-names') } : null,
    toast: shown('toast') ? txt('toast') : null,
    status: txt('status'),
    note: shown('note') ? txt('note') : null,
    strip: txt('strip-word'),
    drawer: shown('drawer') ? txt('drawer-title') : null,
    keys: shown('drawer') ? document.querySelector('.proof-list')?.textContent?.match(/(\d+) access keys?/)?.[0] ?? null : null,
  }
}

const seen = { throws: new Set(), banners: [], firstNight: null, visitor: null }
let last = {}
let latest = null
let throwsBusy = false

/** Names the throws the page has just shown, from the contract's recent_throws. */
async function nameThrows(nightNo) {
  if (throwsBusy) return
  throwsBusy = true
  try {
    const recent = await view('recent_throws')
    for (const t of recent) {
      const key = `${t.night}:${t.at_ms}:${t.account}:${t.amount}`
      if (seen.throws.has(key)) continue
      seen.throws.add(key)
      if (nightNo != null && t.night < nightNo) continue
      const who = LABELS[t.account] ?? (t.account === seen.visitor ? 'visitor' : t.account)
      mark('throw', { who, night: t.night, window: t.window, amount: ember(t.amount), pile: ember(t.pile), at_ms: t.at_ms })
    }
  } catch (e) {
    log('recent_throws:', e.message)
  } finally {
    throwsBusy = false
  }
}

async function watch(page) {
  // throws before the take are not news
  try {
    for (const t of await view('recent_throws')) seen.throws.add(`${t.night}:${t.at_ms}:${t.account}:${t.amount}`)
  } catch {}
  for (;;) {
    let st
    try {
      st = await page.eval(snapshot)
    } catch {
      await sleep(200)
      continue
    }
    latest = st
    const nightNo = Number(String(st.night ?? '').replace(/\D+/g, '')) || null
    if (st.live && !last.live) mark('live', { night: nightNo, pile: st.pile, target: st.target })
    if (st.live && nightNo && nightNo !== Number(String(last.night ?? '').replace(/\D+/g, ''))) {
      if (seen.firstNight == null) seen.firstNight = nightNo
      mark('night', { night: nightNo, target: st.target })
    }
    if (st.live && st.pile !== last.pile) {
      mark('pile', { pile: st.pile, target: st.target, need: st.need })
      nameThrows(nightNo)
    }
    for (const k of ['firestarter', 'lastLog', 'throwers', 'streak', 'balance', 'myWood', 'myShare', 'early', 'hint', 'status', 'note', 'strip', 'chips', 'need']) {
      if (st.live && st[k] !== last[k]) mark(k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), { text: st[k] })
    }
    if (st.kindle !== last.kindle) mark('kindle', { shown: st.kindle })
    if (st.ready !== last.ready) mark('ready', { text: st.ready })
    if (JSON.stringify(st.banner) !== JSON.stringify(last.banner)) {
      if (st.banner) {
        seen.banners.push(st.banner)
        mark('banner', st.banner)
      } else mark('banner-hidden')
    }
    if (st.toast !== last.toast) mark('toast', { text: st.toast })
    if (st.drawer !== last.drawer) mark('drawer', { title: st.drawer })
    if (st.keys !== last.keys && st.keys) mark('keys', { text: st.keys })
    last = st
    await sleep(200)
  }
}

const until = async (what, fn, timeoutMs, every = 250) => {
  const t0 = Date.now()
  for (;;) {
    const v = latest && fn(latest)
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out: ${what}`)
    await sleep(every)
  }
}

/** The throw button labelled `label`, or the smallest one. */
async function chipSelector(page, label) {
  const i = await page.eval((l) => {
    const bs = [...document.querySelectorAll('#throw-row button')]
    const k = bs.findIndex((b) => b.querySelector('b')?.textContent === l)
    return k >= 0 ? k : 0
  }, label)
  return `#throw-row button:nth-child(${i + 1})`
}

// ---- the take -----------------------------------------------------------------------------------

async function play(page, cfg) {
  const nightMs = Number(cfg.config.night_ms)
  const endOf = (n) => Number(cfg.genesis_ms) + n * nightMs

  await until('page live with kindling', (s) => s.live && s.kindle, 40000)
  await sleep(2600)
  // night A: kindling, then hover the throw so the hint says what the wood counts, then throw
  await click(page, '#btn-kindle', 'Get kindling')
  await until('throw buttons', (s) => /\d/.test(s.chips) && !/\(off\)/.test(s.chips) && !s.kindle, 60000)
  await sleep(1400)
  const first = await chipSelector(page, FIRST)
  await hover(page, first, `chip ${FIRST}`)
  await until('hint', (s) => /^Throw /.test(s.hint ?? ''), 8000).catch(() => {})
  await sleep(3000)
  await click(page, first, `throw ${FIRST}`)
  await sleep(700)
  await moveTo(page, W * 0.8, H * 0.88, 600)
  await until('my wood on the pile', (s) => s.myWood && s.myWood !== '0', 60000)

  // dawn of A: the banner, then collect
  await until(`banner of night ${NIGHT}`, (s) => s.banner && s.banner.kicker?.includes(`Night ${NIGHT} `), endOf(NIGHT) - Date.now() + 120000)
  await sleep(4200)
  await until('collect button', (s) => s.ready, 30000)
  await click(page, '#btn-collect', 'Collect')
  await until('collected toast', (s) => /collected/.test(s.toast ?? ''), 45000).catch((e) => log(e.message))
  await sleep(1800)
  await moveTo(page, W * 0.8, H * 0.88, 500)

  // night A+1: the under-throw
  await until('throw buttons again', (s) => /\d/.test(s.chips) && !/\(off\)/.test(s.chips) && s.night?.includes(String(SMOKE_NIGHT)), 60000)
  await sleep(600)
  const second = await chipSelector(page, SECOND)
  await hover(page, second, `chip ${SECOND}`)
  await sleep(1800)
  await click(page, second, `throw ${SECOND}`)
  await sleep(700)
  await moveTo(page, W * 0.8, H * 0.88, 600)
  await until(`banner of night ${SMOKE_NIGHT}`, (s) => s.banner && s.banner.kicker?.includes(`Night ${SMOKE_NIGHT} `), endOf(SMOKE_NIGHT) - Date.now() + 120000)
  await sleep(13000)

  // the quiet nights until the face: two frames a second
  if (FACE_AFTER > SMOKE_NIGHT) {
    thin = true
    mark('thin', { on: true })
    await until(`banner of night ${FACE_AFTER}`, (s) => s.banner && s.banner.kicker?.includes(`Night ${FACE_AFTER} `), endOf(FACE_AFTER) - Date.now() + 120000)
    thin = false
    mark('thin', { on: false })
    await sleep(6000)
  }
  await face(page)
}

async function face(page) {
  // the coin's face as the contract draws it now, and the keys, saved with the take
  try {
    const meta = await view('ft_metadata')
    writeFileSync(join(OUT, 'icon.svg'), decodeURIComponent(meta.icon.replace(/^data:image\/svg\+xml(;utf8)?,/, '')))
    const keys = await rpc({ request_type: 'view_access_key_list', finality: 'final', account_id: CONTRACT })
    writeFileSync(join(OUT, 'keys.json'), JSON.stringify({ account_id: CONTRACT, ...keys }, null, 1))
    mark('keys-rpc', { keys: keys.keys.length, block_height: keys.block_height, block_hash: keys.block_hash })
    const st = await view('state')
    mark('state', { night: st.night, streak: st.streak, last: st.last, records: st.records })
  } catch (e) {
    log('face data:', e.message)
  }
  await moveTo(page, W * 0.82, H * 0.62, 500)
  await wheelTo(page, '.face', 300, 'face')
  mark('face')
  await sleep(7000)
  await wheelTo(page, '#hero', 0, 'top')
  await sleep(1200)
  await click(page, '#btn-proof', 'Proof')
  await until('keys in the proof', (s) => s.keys, 20000).catch((e) => log(e.message))
  await sleep(2500)
  proofTxs = await page
    .eval(() => [...document.querySelectorAll('#drawer-body .tx-list li')].map((li) => ({ kind: li.querySelector('.kind')?.textContent, hash: li.querySelector('a')?.href?.split('/txns/')[1] ?? null, gas: li.querySelector('.gas')?.textContent })))
    .catch(() => [])
  mark('proof-txs', { txs: proofTxs })
  await sleep(4500)
  await click(page, '#drawer-close', 'close')
  await sleep(2500)
}

/**
 * --tour: a fresh visitor's first minute, for the short cut. The page replays last night by itself;
 * then the proof drawer and its "Try to cheat it" (one real throw on tomorrow's fire, which the
 * contract refuses; with --dry the button is only pointed at), then the supply chart.
 */
async function tour(page) {
  await until('replay of last night', (s) => /^Replay/.test(s.banner?.kicker ?? ''), 40000)
  await sleep(5500)
  await click(page, '#btn-proof', 'Proof')
  await until('keys in the proof', (s) => s.keys, 20000).catch((e) => log(e.message))
  await sleep(3000)
  await moveTo(page, W - 200, H * 0.42, 500)
  await wheelTo(page, '.cheats', H * 0.42, 'cheats')
  await sleep(1200)
  if (DRY) await hover(page, '[data-cheat="future"]', 'cheat future')
  else {
    await click(page, '[data-cheat="future"]', 'cheat future')
    await until('the contract answers', (s) => /Refused|went through/.test(s.toast ?? ''), 45000).catch((e) => log(e.message))
  }
  await sleep(1500)
  proofTxs = await page
    .eval(() => [...document.querySelectorAll('#drawer-body .tx-list li')].map((li) => ({ kind: li.querySelector('.kind')?.textContent, hash: li.querySelector('a')?.href?.split('/txns/')[1] ?? null, gas: li.querySelector('.gas')?.textContent })))
    .catch(() => [])
  mark('proof-txs', { txs: proofTxs })
  await sleep(5000)
  await click(page, '#drawer-close', 'close')
  await sleep(1200)
  await moveTo(page, W * 0.5, H * 0.55, 500)
  await wheelTo(page, '.chart-card', 60, 'chart')
  await sleep(1500)
  const box = await page.eval(() => {
    const r = document.querySelector('#chart svg')?.getBoundingClientRect()
    return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null
  })
  if (box) {
    mark('chart-hover')
    for (const k of [0.2, 0.45, 0.7, 0.97]) {
      await moveTo(page, box.x + box.w * k, box.y + box.h * 0.55, 700)
      await sleep(900)
    }
  }
  await sleep(1500)
  await moveTo(page, W * 0.5, H * 0.9, 500)
  await sleep(1500)
}

let thin = false
let proofTxs = []

async function main() {
  const cfg = await view('config')
  const nightMs = Number(cfg.config.night_ms)
  const startOf = (n) => Number(cfg.genesis_ms) + (n - 1) * nightMs
  const st0 = await view('state')
  const offset = st0.now_ms - Date.now() // the chain's clock against ours
  if (!DRY && !(TOUR && !NIGHT)) {
    if (!NIGHT) throw new Error('--night is required')
    const openAt = startOf(NIGHT) + OPEN_AFTER * 1000 - offset
    if (Date.now() > openAt + 20000) throw new Error(`night ${NIGHT} began ${Math.round((Date.now() - openAt) / 1000)} s ago: too late for a fresh start`)
    log(`waiting ${Math.max(0, Math.round((openAt - Date.now()) / 1000))} s for night ${NIGHT} + ${OPEN_AFTER} s`)
    while (Date.now() < openAt - 4000) await sleep(Math.min(20000, openAt - 4000 - Date.now()))
  }
  const server = await serve(ROOT, SERVE_PORT)
  const url = `${server.url}web/`
  const chrome = await launchChrome({ port: PORT, profileDir: PROFILE, width: W, height: H, extraArgs: ['--force-color-profile=srgb', '--font-render-hinting=none', '--mute-audio', ...(process.env.CAPTURE_CHROME_ARGS ?? '').split(' ').filter(Boolean)] })
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  const page = new Page(ws, chrome)
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Network.enable')
  await page.send('Network.setCacheDisabled', { cacheDisabled: true })
  await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: SCALE, mobile: false })
  await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 7, g: 6, b: 13, a: 1 } })
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true })

  let frames = 0
  let lastSaved = 0
  page.on('Page.screencastFrame', (p) => {
    page.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {})
    const t = p.metadata.timestamp
    if (thin && t - lastSaved < 0.5) return
    lastSaved = t
    frames++
    writeFileSync(join(OUT, 'frames', `f${String(frames).padStart(6, '0')}.jpg`), Buffer.from(p.data, 'base64'))
    framesOut.write(JSON.stringify({ i: frames, t }) + '\n')
  })
  await page.send('Page.startScreencast', { format: 'jpeg', quality: QUALITY, maxWidth: Math.round(W * SCALE), maxHeight: Math.round(H * SCALE), everyNthFrame: 1 })
  mark('record', { url, viewport: [W, H], scale: SCALE, contract: CONTRACT, night: NIGHT, smokeNight: SMOKE_NIGHT, faceAfter: FACE_AFTER })
  await sleep(300)
  await page.send('Page.navigate', { url })
  const watcher = watch(page)
  const t0 = Date.now()
  try {
    await until('page live', (s) => s.live, 40000)
    seen.visitor = await page.eval(() => {
      for (let i = 0; i < localStorage.length; i++) {
        try {
          const v = JSON.parse(localStorage.getItem(localStorage.key(i)))
          if (v?.pub) return v.pub
        } catch {}
      }
      return null
    })
    mark('visitor', { account: seen.visitor })
    if (TOUR) {
      await tour(page)
      return
    }
    if (DRY) {
      await sleep(15000)
      return
    }
    await play(page, cfg)
  } catch (e) {
    mark('error', { message: e.message })
    console.error(e)
  } finally {
    mark('end', { frames, seconds: Math.round((Date.now() - t0) / 1000) })
    await page.send('Page.stopScreencast').catch(() => {})
    await sleep(500)
    const txs = proofTxs // the visitor's transactions, as the proof drawer listed them
    writeFileSync(join(OUT, 'take.json'), JSON.stringify({ url, contract: CONTRACT, visitor: seen.visitor, night: NIGHT, smokeNight: SMOKE_NIGHT, faceAfter: FACE_AFTER, firstNight: seen.firstNight, banners: seen.banners, frames, txs, console: page.console.slice(-40) }, null, 2))
    eventsOut.end()
    framesOut.end()
    await page.close().catch(() => {})
    chrome.kill()
    server.close()
    watcher.catch(() => {})
    log(`done: ${frames} frames, ${txs.length} transactions in the proof`)
    process.exit(0)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
