// The page controller: boots the scene, reads the contract, settles nights that are due, turns taps
// into signed actions and the chain's answers into pictures.
//
// Mock mode runs only with `?mock=1` in the URL; without it the page talks to NEAR testnet and shows
// nothing that did not come from the chain.
import { ed25519Supported } from './near.js'
import { ActionQueue, Client, FriendlyError, loadOrCreateIdentity, notDeployed } from './chain.js'
import { CODE_HASH, CONTRACT, EXPLORER, GAS_ACCOUNT } from './config.js'
import { Scene } from './scene.js'
import { Sound } from './audio.js'
import * as L from './logic.js'
import * as U from './ui.js'

const params = new URLSearchParams(location.search)
const MOCK = params.get('mock') === '1'
const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

const S = {
  cfg: null,
  state: null,
  holder: null,
  tonight: null,
  model: null,
  history: [],
  offset: null,
  offsetAt: 0,
  lastSettled: null,
  woodSeen: new Map(), // account -> wood on tonight's pile, to spot new throws
  woodNight: null,
  settling: false,
  lastSettleTry: 0,
  pollTimer: null,
  failures: 0,
  phase: 'boot', // boot | live | cold | offline
  keys: null,
  codeHash: CODE_HASH,
  deployed: true,
  icon: null,
  selected: null, // index of the throw chip the hint describes
  bannerTimer: null,
  canSign: true,
}

let client
let scene
let queue
const sound = new Sound()

// ---- boot ---------------------------------------------------------------------------------------

async function boot() {
  scene = new Scene(U.$('scene'), { reducedMotion: reduced })
  layout()
  scene.setNight({ progress: 0.35, pct: 0, reached: false, pileText: '', targetText: '' })
  scene.start()
  window.addEventListener('resize', layout)
  wire()

  if (MOCK) {
    const { MockClient } = await import('./mock.js')
    const nightS = Number(params.get('night')) || 300
    client = new MockClient({ scene: params.get('scene') || 'live', nightMs: Math.max(20, nightS) * 1000 })
    U.$('mock-badge').hidden = false
    document.title = 'MOCK · ' + document.title
  } else {
    client = new Client()
    client.rpc.onHostChange = (h) => console.info('rpc host', h)
  }
  client.onTx = () => U.drawerOpen() && U.$('drawer-title').textContent === 'Proof' && openProof()
  queue = new ActionQueue(client, { onDone, onError, onChange: renderYou })

  S.canSign = await ed25519Supported()
  // The key lives in this browser only; making it needs no network.
  const identity = S.canSign ? await loadOrCreateIdentity(globalThis.localStorage, MOCK ? 'bonfire:mock-key:v1' : undefined) : null
  client.identity = identity
  try {
    S.cfg = await client.config()
  } catch (e) {
    return bootFailed(e)
  }
  U.$('how-body').innerHTML = U.howHtml(S.cfg)
  if (identity) S.holder = await client.setIdentity(identity).catch(() => null)
  S.phase = 'live'
  document.body.classList.add('live')
  await poll()
  loadHistory()
  loadIcon()
  setInterval(tickClock, 250)
  document.addEventListener('visibilitychange', () => schedule(document.hidden ? 8000 : 300))
}

function bootFailed(e) {
  console.info('boot', e?.message ?? e)
  if (!MOCK && notDeployed(e)) {
    S.phase = 'cold'
    S.deployed = false
    document.body.classList.add('cold')
    scene.setNight({ progress: 0.3, pct: 0.4, reached: false, pileText: '', targetText: '', cold: true })
    U.setText('night-label', 'Bonfire')
    U.setText('countdown', 'Not lit yet')
    U.setText('until', `the contract ${CONTRACT} is not on NEAR testnet yet`)
    showNote('The fire has not been lit yet. Once the contract is live, this page shows tonight’s pile and lets you throw wood.')
    return
  }
  S.phase = 'offline'
  document.body.classList.add('offline')
  scene.setNight({ progress: 0.3, pct: 0.4, reached: false, pileText: '', targetText: '', cold: true })
  U.setText('countdown', 'Out of reach')
  U.setText('until', 'NEAR testnet did not answer. Retrying…')
  showNote('Could not reach NEAR testnet. The page keeps trying.')
  setTimeout(() => location.reload(), 30_000)
}

function layout() {
  const phone = window.matchMedia('(max-width: 900px)').matches
  scene.setLayout({ cx: 0.5, by: phone ? 0.82 : 0.75, scale: phone ? 1.28 : 1.12, moonY: phone ? 0.47 : 0.32 })
}

function wire() {
  U.$('btn-proof').addEventListener('click', openProof)
  U.$('btn-how').addEventListener('click', () => {
    const d = U.$('how')
    d.open = true
    d.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
  })
  U.$('btn-sound').addEventListener('click', () => {
    sound.setOn(!sound.on)
    renderSound()
  })
  U.$('btn-kindle').addEventListener('click', onKindle)
  U.$('drawer-close').addEventListener('click', U.closeDrawer)
  U.$('drawer-backdrop').addEventListener('click', U.closeDrawer)
  document.addEventListener('keydown', (e) => e.key === 'Escape' && U.drawerOpen() && U.closeDrawer())
  renderSound()
}

function renderSound() {
  const b = U.$('btn-sound')
  b.setAttribute('aria-pressed', String(sound.on))
  b.setAttribute('aria-label', sound.on ? 'Sound is on' : 'Sound is off')
  b.querySelector('.ico').classList.toggle('off', !sound.on)
}

// ---- the poll loop ------------------------------------------------------------------------------

const chainNow = () => Date.now() + (S.offset ?? 0)

function schedule(ms) {
  clearTimeout(S.pollTimer)
  S.pollTimer = setTimeout(poll, ms)
}

async function poll() {
  clearTimeout(S.pollTimer)
  try {
    const me = client.identity?.account
    const [state, holder] = await Promise.all([client.state(), me ? client.holder(me) : Promise.resolve(null)])
    noteClock(state.now_ms)
    S.state = state
    if (holder) S.holder = holder
    const before = S.tonight
    if (state.throwers !== (S.tonight?.throwers?.length ?? -1) || state.night !== S.tonight?.night || state.pile !== S.tonight?.pile) {
      S.tonight = await client.night(state.night)
      spotThrows()
    }
    const lastNight = state.last?.night ?? 0
    if (S.lastSettled === null) S.lastSettled = lastNight
    else if (lastNight > S.lastSettled) {
      S.lastSettled = lastNight
      onSettled(state.last, before)
    }
    S.failures = 0
    render()
    if (S.model.due) settleSoon()
  } catch (e) {
    S.failures++
    console.info('poll', e?.message ?? e)
    if (S.failures === 3) U.toast('The connection to NEAR testnet is shaky. Still trying.', 'warn')
  }
  schedule(document.hidden ? 8000 : S.model?.due ? 1200 : 2000)
}

/** The chain's clock: keep the newest offset, since a view can lag but never run ahead. */
function noteClock(nowMs) {
  const off = Number(nowMs) - Date.now()
  if (S.offset === null || off > S.offset || Date.now() - S.offsetAt > 30_000) {
    S.offset = off
    S.offsetAt = Date.now()
  }
}

/** New wood on tonight's pile from someone: a log flies from their seat. */
function spotThrows() {
  const t = S.tonight
  if (!t) return
  const me = client.identity?.account
  const fresh = S.woodNight !== t.night
  for (const th of t.throwers) {
    const now = L.big(th.wood)
    const before = S.woodSeen.get(th.account) ?? 0n
    if (!fresh && now > before && th.account !== me) {
      scene.throwFrom(th.account, '+' + L.fmtEmber(now - before, S.cfg.config.decimals))
      sound.thud()
    }
  }
  S.woodSeen = new Map(t.throwers.map((th) => [th.account, L.big(th.wood)]))
  S.woodNight = t.night
}

async function settleSoon() {
  if (S.settling || !client.canAct || Date.now() - S.lastSettleTry < 5000) return
  S.settling = true
  S.lastSettleTry = Date.now()
  try {
    const out = await client.settle()
    if (out?.nights_due > 0) S.lastSettleTry = 0
    schedule(150)
  } catch (e) {
    console.info('settle', e?.message ?? e)
  } finally {
    S.settling = false
  }
}

async function onSettled(last, before) {
  // while last night burns, its throwers stay at the fire
  if (before?.night === last.night) S.seatHold = { throwers: before.throwers, until: Date.now() + 9500 }
  scene.outcome(last.outcome)
  if (last.outcome === 'lit') sound.roar()
  else sound.hiss()
  const dec = S.cfg.config.decimals
  let result = null
  try {
    result = L.nightResult(await client.night(last.night), client.identity?.account, dec, S.cfg.config.symbol)
  } catch {
    /* the banner falls back to the outcome alone */
  }
  showBanner(last, result)
  loadHistory()
  loadIcon()
}

function showBanner(last, result) {
  const el = U.$('banner')
  el.className = `banner ${last.outcome}`
  U.setText('banner-kicker', `Night ${last.night}`)
  U.setText('banner-title', last.outcome === 'lit' ? 'The fire caught!' : last.outcome === 'smoke' ? 'Up in smoke' : 'A cold night')
  U.setText('banner-text', result?.text ?? '')
  el.hidden = false
  document.body.classList.add('banner-on')
  clearTimeout(S.bannerTimer)
  S.bannerTimer = setTimeout(() => {
    el.hidden = true
    document.body.classList.remove('banner-on')
  }, 11_000)
}

async function loadHistory() {
  try {
    const n = S.state?.night ?? 1
    S.history = await client.history(L.historyFrom(n, 200), 200)
    renderHistory()
  } catch (e) {
    console.info('history', e?.message ?? e)
  }
}

async function loadIcon() {
  try {
    const meta = await client.ftMetadata()
    const icon = L.safeIcon(meta.icon)
    if (icon && icon !== S.icon) {
      S.icon = icon
      U.$('coin-face').src = icon
      U.$('coin-mini').src = icon
    }
  } catch (e) {
    console.info('icon', e?.message ?? e)
  }
}

// ---- actions ------------------------------------------------------------------------------------

function onThrow(choice) {
  const m = S.model
  if (!m || !m.canThrow || !client.canAct) return
  sound.enable()
  const amount = choice.amount
  // name the night the chain's clock says now; `act` settles an ended night before the throw lands
  const night = L.clockNight(chainNow(), Number(S.cfg.genesis_ms), m.nightMs)
  queue.push({ kind: 'throw', amount, night, build() {
    return L.throwAction(this.amount, this.night)
  } })
  scene.throwFrom(client.identity.account, '+' + L.fmtEmber(amount, m.dec))
  sound.thud()
  renderYou()
}

function onKindle() {
  const m = S.model
  if (!m?.kindle.can || !client.canAct) return
  sound.enable()
  const night = L.clockNight(chainNow(), Number(S.cfg.genesis_ms), m.nightMs)
  queue.push({ kind: 'kindling', build: () => L.kindlingAction(night) })
  U.$('btn-kindle').disabled = true
  renderYou()
}

function onDone(out, item) {
  if (!out?.ok) {
    sound.refuse()
    U.toast(refusal(out?.error, item), 'warn', 6000)
  } else if (item.kind === 'kindling') {
    sound.chime()
    U.toast(`${L.fmtEmber(S.model.kindling, S.model.dec)} EMBER of kindling is yours. Throw some on the fire.`, 'ok')
  }
  U.$('btn-kindle').disabled = false
  schedule(100)
}

function onError(err, item) {
  sound.refuse()
  U.toast(err instanceof FriendlyError ? err.message : `That ${item.kind === 'throw' ? 'throw' : 'claim'} did not go through. Nothing was lost.`, 'warn', 6000)
  U.$('btn-kindle').disabled = false
  schedule(100)
}

function refusal(error = '', item) {
  if (/is for night/.test(error)) return item.kind === 'throw' ? 'Dawn came first. Your wood is still yours: throw it on tonight’s fire.' : 'Dawn came first. Try again for tonight.'
  if (/handed out/.test(error)) return 'Tonight’s kindling is all handed out. Come back next night.'
  if (/never held/.test(error)) return 'Kindling is only for newcomers, and this account already has EMBER.'
  if (/not enough/.test(error)) return 'Not enough free EMBER for that throw.'
  if (/room for|seats/.test(error)) return 'Every seat at tonight’s fire is taken. Come early next night.'
  return `The fire keeper said no: ${error}`
}

// ---- render -------------------------------------------------------------------------------------

function render() {
  if (!S.cfg || !S.state) return
  S.model = L.deriveModel({ cfg: S.cfg, state: S.state, holder: S.holder, tonight: S.tonight, nowMs: chainNow() })
  const m = S.model
  const f = (u) => L.fmtEmber(u, m.dec)
  const w = (u) => L.fmtWhole(u, m.dec)
  scene.setNight({
    progress: m.progress,
    pct: m.pct,
    reached: m.reached,
    pileText: m.pile > 0n ? `${w(m.pile)} on the pile` : '',
    pileShort: m.pile > 0n ? w(m.pile) : '',
    targetText: m.reached ? `✓ ${w(m.target)} reached` : `${w(m.target)} needed`,
  })
  sound.setHeat(scene.heat)
  const held = S.seatHold && Date.now() < S.seatHold.until && (S.tonight?.throwers?.length ?? 0) < S.seatHold.throwers.length
  const { shown, more } = L.seats(held ? S.seatHold.throwers : S.tonight?.throwers, client.identity?.account, window.matchMedia('(max-width: 900px)').matches ? 8 : 10)
  scene.setSeats(shown, more)
  U.$('scene').setAttribute('aria-label', `Night ${m.night}: ${w(m.pile)} of ${w(m.target)} EMBER on the pile, ${m.throwers} throwers.`)

  // tonight
  const h = L.headline(m)
  U.setText('need-big', h.big)
  U.setText('need-small', h.small)
  const pct = Math.min(1, m.pct)
  U.$('meter-fill').style.setProperty('--p', `${(pct * 100).toFixed(1)}%`)
  U.$('meter').classList.toggle('reached', m.reached)
  U.$('meter').setAttribute('aria-valuenow', String(Math.round(m.pct * 100)))
  U.setText('pile-num', w(m.pile))
  U.setText('target-num', w(m.target))
  U.setText('throwers', String(m.throwers))
  U.setText('streak', m.streak === 1 ? '1 night' : `${m.streak} nights`)
  U.setText('hearth', L.fmtEmber(m.hearth, m.dec, { compact: true }))
  U.setText('kindling-left', m.kindlingLeft > 0 ? `Kindling left tonight: ${m.kindlingLeft} of ${m.kindlingPerNight}` : 'No kindling left tonight')
  renderYou()
  renderRecords()
  tickClock()
}

function tickClock() {
  const m = S.model
  if (!m || S.phase !== 'live') return
  const now = chainNow()
  const left = Math.max(0, m.end - now)
  U.setText('night-label', `Night ${m.night}`)
  const due = left <= 0 || m.due
  U.setText('countdown', due ? 'Dawn' : L.fmtCountdown(left))
  U.setText('until', due ? (client.canAct ? 'lighting the fire…' : 'the next visitor lights the fire') : 'until dawn')
  U.$('clock').classList.toggle('late', !due && left < m.nightMs * 0.15)
  const early = L.earlyBp(Math.max(0, now - m.start), m.nightMs, S.cfg.config.early_max_bp)
  U.setText('early', m.reached ? `${L.fmtFactor(S.cfg.config.late_lit_bp)} (pile is full)` : L.fmtFactor(early))
  if (scene) scene.progress = Math.min(1, Math.max(0, (now - m.start) / m.nightMs))
}

function renderYou() {
  const m = S.model
  if (!m) return
  const f = (u) => L.fmtEmber(u, m.dec)
  const pending = queue?.pendingWood() ?? 0n
  const balance = m.balance > pending ? m.balance - pending : 0n
  U.setText('balance', S.holder ? f(balance) : '–')
  const wood = m.myWood + pending
  U.setText('my-wood', f(wood))
  const share = U.$('my-share')
  if (m.myWood > 0n) {
    share.textContent = `+${f(m.reward)} new`
    share.className = 'good'
  } else {
    share.textContent = pending > 0n ? 'counting…' : '–'
    share.className = ''
  }

  const canAct = client.canAct && S.canSign
  const kindle = U.$('btn-kindle')
  const showKindle = m.kindle.can && m.balance === 0n && m.myWood === 0n
  kindle.hidden = !showKindle
  U.setText('kindle-sub', `${f(m.kindling)} EMBER from the hearth, free, once`)
  kindle.disabled = !canAct || queue.busy

  const row = U.$('throw-row')
  const choices = m.balance > pending ? L.throwChoices(m.balance - pending, m.dec, m.minThrow) : []
  const key = choices.map((c) => c.amount.toString()).join(',') + `|${m.canThrow}|${canAct}`
  if (row.dataset.key !== key) {
    row.dataset.key = key
    row.replaceChildren()
    choices.forEach((c, i) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'chip' + (c.all ? ' all' : '')
      b.disabled = !m.canThrow || !canAct
      const t = document.createElement('b')
      t.textContent = c.all ? 'All in' : c.label
      const s = document.createElement('span')
      s.textContent = c.all ? f(c.amount) : 'EMBER'
      b.append(t, s)
      b.addEventListener('click', () => onThrow(c))
      b.addEventListener('pointerenter', () => hint(i))
      b.addEventListener('focus', () => hint(i))
      row.appendChild(b)
    })
    row.hidden = !choices.length
  }
  S.choices = choices
  hint(S.selected)

  let note = ''
  if (!S.canSign) note = 'This browser cannot make a signing key (Ed25519). Chrome 137, Safari 17 or Firefox 130 and newer can.'
  else if (!client.canAct) note = 'Watching only for now: the public gas pool that pays for moves is not funded yet.'
  else if (!showKindle && m.balance === 0n && m.myWood === 0n) {
    note = { gone: 'Tonight’s kindling is handed out. Come back next night for yours.', dry: 'The hearth has no kindling left.', full: 'The hearth pays for no more new accounts.', claimed: 'You have no free EMBER right now.', holder: 'You have no free EMBER right now.' }[m.kindle.why] ?? ''
  } else if (m.due) note = 'Dawn is breaking. Throws open again in a moment.'
  showNote(note)

  const st = U.$('status')
  st.textContent = queue?.inflight ? (queue.inflight.kind === 'throw' ? `Throwing ${f(queue.inflight.amount)} EMBER…` : 'Fetching kindling…') : ''
  st.classList.toggle('busy', !!queue?.inflight)
}

function hint(i) {
  const m = S.model
  const el = U.$('throw-hint')
  const choices = S.choices ?? []
  if (!m || !choices.length || !m.canThrow) {
    el.textContent = ''
    return
  }
  S.selected = i
  const c = choices[i ?? Math.min(1, choices.length - 1)] ?? choices[0]
  const p = L.throwPreview(m, c.amount)
  const f = (u) => L.fmtEmber(u, m.dec)
  const factor = L.fmtFactor(m.reached ? m.lateLitBp : m.earlyBp)
  el.textContent = `Throw ${f(c.amount)} now (counts ${factor}): about +${f(p.gain)} new EMBER if it catches.`
}

function showNote(text) {
  const n = U.$('note')
  n.textContent = text
  n.hidden = !text
}

function renderHistory() {
  const dec = S.cfg.config.decimals
  const sym = S.cfg.config.symbol
  U.renderStrip(U.$('strip'), L.nightStrip(S.history, 24), { decimals: dec, symbol: sym })
  U.renderChart(U.$('chart'), L.supplySeries(S.history, dec), { symbol: sym })
}

function renderRecords() {
  const r = S.state?.records
  if (!r) return
  const dec = S.cfg.config.decimals
  U.setText('rec-streak', r.longest_streak === 1 ? '1 night' : `${r.longest_streak} nights`)
  U.setText('rec-tallest', L.big(r.tallest_fire) > 0n ? L.fmtEmber(r.tallest_fire, dec) : '–')
  U.setText('rec-minted', L.fmtEmber(r.total_minted, dec, { compact: true }))
  U.setText('rec-burned', L.fmtEmber(r.total_burned, dec, { compact: true }))
  U.setText('tally', `${r.nights_lit} lit · ${r.nights_smoke} smoke · ${r.nights_empty} cold · ${r.kindling_claims} kindling claim${r.kindling_claims === 1 ? '' : 's'}`)
}

let resizeTimer = null
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => S.cfg && renderHistory(), 200)
})

// ---- proof --------------------------------------------------------------------------------------

async function openProof() {
  const draw = () =>
    U.proofHtml({
      mock: MOCK,
      contract: client?.contract ?? CONTRACT,
      keys: S.keys,
      codeHash: S.codeHash,
      account: client?.identity?.account ?? '–',
      gasAccount: GAS_ACCOUNT,
      rpcHost: client?.rpc?.host ?? '–',
      txs: client?.txs ?? [],
      explorer: EXPLORER,
      deployed: S.deployed,
    })
  U.openDrawer('Proof', draw())
  if (S.keys === null && client) {
    try {
      S.keys = await client.accessKeys()
      const acc = await client.viewAccount()
      S.codeHash = acc?.code_hash ?? S.codeHash
    } catch (e) {
      if (notDeployed(e)) {
        S.deployed = false
        S.keys = []
      }
    }
    if (U.drawerOpen()) U.$('drawer-body').innerHTML = draw()
  }
}

boot()
