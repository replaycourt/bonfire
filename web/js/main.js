// The page controller: boots the scene, reads the contract, settles nights that are due, collects
// what settled nights owe, turns taps into signed actions and the chain's answers into pictures.
//
// Mock mode runs only with `?mock=1` in the URL; without it the page talks to NEAR testnet and shows
// nothing that did not come from the chain.
import { ed25519Supported } from './near.js'
import { ActionQueue, Client, FriendlyError, loadOrCreateIdentity, notDeployed } from './chain.js'
import { BOTS, CODE_HASH, CONTRACT, DEPLOYMENT, EXPLORER, GAS_ACCOUNT, HELP_COLLECTS_PER_VISIT } from './config.js'
import { Scene } from './scene.js'
import { Sound } from './audio.js'
import * as L from './logic.js'
import * as U from './ui.js'

const params = new URLSearchParams(location.search)
const MOCK = params.get('mock') === '1'
const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
const phone = () => window.matchMedia('(max-width: 900px)').matches

const S = {
  cfg: null,
  state: null,
  holder: null,
  recent: [],
  seen: null, // keys of recent throws already shown
  model: null,
  history: [],
  ledger: { shown: 12, older: [], complete: false, details: new Map(), asked: new Set(), loading: false },
  offset: null,
  offsetAt: 0,
  lastSettled: null,
  replayed: false, // last night has been played back once (replayLastNight)
  replaying: false, // the playback owns the scene's pile until its banner is up
  nightThrowers: null, // { night, list }: who sat at the fire of the night on screen
  seatHold: null,
  settling: false,
  lastSettleTry: 0,
  pollTimer: null,
  failures: 0,
  phase: 'boot', // boot | live | cold | offline
  keys: null,
  codeHash: null, // the deployed code's hash, as view_account reports it
  deployed: true,
  icon: null,
  selected: null, // index of the throw chip the hint describes
  estimate: null, // { key, est }
  estimating: null,
  bannerTimer: null,
  canSign: true,
  helped: 0, // collections relayed for other throwers this visit
  tried: new Set(),
  helpTimer: null,
  firestarter: null,
  lastLog: null,
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
  document.fonts?.ready.then(layout) // the rules may wrap differently once the fonts are in
  wire()

  if (MOCK) {
    const { MockClient } = await import('./mock.js')
    const nightS = Number(params.get('night')) || 300
    client = new MockClient({ scene: params.get('scene') || 'live', nightMs: Math.max(20, nightS) * 1000, contract: CONTRACT })
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
  scheduleHelp(25_000)
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
    U.setText('until', `the contract ${CONTRACT} is not live on NEAR testnet yet`)
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
  scene.setLayout({ cx: 0.5, by: phone() ? 0.82 : 0.75, scale: phone() ? 1.28 : 1.12, moonY: L.moonY(phone() ? 0.47 : 0.32, U.$('stage')?.getBoundingClientRect(), document.querySelector('.sky-text')?.getBoundingClientRect()) })
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
  U.$('btn-collect').addEventListener('click', onCollect)
  U.$('btn-older').addEventListener('click', showOlder)
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
const clockNow = () => L.clockNight(chainNow(), Number(S.cfg.genesis_ms), Number(S.cfg.config.night_ms))

function schedule(ms) {
  clearTimeout(S.pollTimer)
  S.pollTimer = setTimeout(poll, ms)
}

async function poll() {
  clearTimeout(S.pollTimer)
  try {
    const me = client.identity?.account
    const [state, holder, recent] = await Promise.all([client.state(), me ? client.holder(me) : Promise.resolve(null), client.recentThrows().catch(() => S.recent)])
    noteClock(state.now_ms)
    S.state = state
    if (holder) S.holder = holder
    S.recent = recent ?? []
    spotThrows()
    const lastNight = state.last?.night ?? 0
    if (S.lastSettled === null) {
      S.lastSettled = lastNight
      setTimeout(() => replayLastNight(state.last), 1500)
    } else if (lastNight > S.lastSettled) {
      S.lastSettled = lastNight
      onSettled(state.last)
    }
    spotNames(state)
    S.failures = 0
    render()
    if (S.model.due) settleSoon()
    refreshEstimate()
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

/** New throws by others in `recent_throws`: a log flies from their seat. */
function spotThrows() {
  const me = client.identity?.account
  const keys = S.recent.map(L.throwKey)
  if (S.seen) {
    S.recent.forEach((t, i) => {
      if (S.seen.has(keys[i]) || t.account === me || t.night !== S.state.night) return
      scene.throwFrom(t.account, '+' + L.fmtEmber(t.amount, S.cfg.config.decimals))
      sound.thud()
    })
  }
  S.seen = new Set(keys)
}

/** The night's firestarter and last log, the moment they happen. */
function spotNames(state) {
  const me = client.identity?.account
  if (state.firestarter && S.firestarter !== null && S.firestarter !== state.firestarter && state.firestarter) scene.cheer(`${L.nameOf(state.firestarter, me, BOTS)} lit the first log`)
  if (state.last_log && S.lastLog !== null && !S.lastLog && state.last_log) scene.cheer(`Last log: ${L.nameOf(state.last_log.account, me, BOTS)}`, true)
  S.firestarter = state.firestarter ?? ''
  S.lastLog = state.last_log ?? ''
}

async function settleSoon() {
  if (S.settling || !client.canAct || Date.now() - S.lastSettleTry < 5000) return
  S.settling = true
  S.lastSettleTry = Date.now()
  try {
    // Every open page sees dawn at the same moment. Each waits a random moment and settles only if
    // the chain still has a night due, so the gas pool pays for one settle a dawn, not one per page.
    await new Promise((r) => setTimeout(r, L.settleDelay()))
    if (!L.settleNeeded(await client.state(), document.hidden)) {
      S.lastSettleTry = Date.now() - 3500 // the chain's clock may lag ours: look again shortly
      schedule(150)
      return
    }
    const out = await client.settle()
    if (out?.nights_due > 0) S.lastSettleTry = 0
    schedule(150)
  } catch (e) {
    console.info('settle', e?.message ?? e)
  } finally {
    S.settling = false
  }
}

/**
 * The payoff at first sight: once per visit, last night plays back in about five seconds (its pile
 * rising against its target, then dawn and the banner), so a visitor sees what a night is without
 * waiting for this one to end. It reads state.last and night(n); nothing is sent. Cold nights have
 * nothing to show and are skipped, and so is the playback for reduced motion.
 */
function replayLastNight(last) {
  if (S.replayed || reduced || !last || !['LIT', 'SMOKED'].includes(last.outcome)) return
  const pile = BigInt(last.pile ?? 0)
  const target = BigInt(last.target ?? 0)
  if (pile <= 0n || target <= 0n || S.state?.last?.night !== last.night) return
  S.replayed = true
  S.replaying = true
  const w = (u) => L.fmtWhole(u, S.cfg.config.decimals)
  scene.cheer(`Night ${last.night}, replayed in five seconds`)
  const t0 = performance.now()
  const step = () => {
    const f = Math.min(1, (performance.now() - t0) / 4500)
    const p = (pile * BigInt(Math.round(f * 1000))) / 1000n
    const reached = p >= target
    scene.setNight({
      progress: f,
      pct: Number((p * 1000n) / target) / 1000,
      reached,
      pileText: p > 0n ? `${w(p)} on the pile` : '',
      pileShort: p > 0n ? w(p) : '',
      targetText: reached ? `✓ ${w(target)} reached` : `${w(target)} needed`,
    })
    if (f < 1) return void requestAnimationFrame(step)
    scene.outcome(last.outcome)
    client
      .night(last.night)
      .then((n) => L.nightResult(n, S.holder, client.identity?.account, S.cfg.config.decimals, S.cfg.config.symbol, BOTS))
      .catch(() => null)
      .then((result) => {
        showBanner(last, result)
        U.setText('banner-kicker', `Replay of last night · Night ${last.night} · ${result?.word ?? last.outcome}`)
        setTimeout(() => {
          S.replaying = false
          render()
        }, 3000)
      })
  }
  requestAnimationFrame(step)
}

async function onSettled(last) {
  // while last night burns, its throwers stay at the fire
  if (S.nightThrowers?.night === last.night) S.seatHold = { list: S.nightThrowers.list, until: Date.now() + 9500 }
  scene.outcome(last.outcome)
  if (last.outcome === 'LIT') sound.roar()
  else sound.hiss()
  let result = null
  try {
    result = L.nightResult(await client.night(last.night), S.holder, client.identity?.account, S.cfg.config.decimals, S.cfg.config.symbol, BOTS)
  } catch {
    /* the banner falls back to the outcome alone */
  }
  showBanner(last, result)
  loadHistory()
  loadIcon()
  scheduleHelp(15_000 + Math.random() * 15_000)
}

function showBanner(last, result) {
  const el = U.$('banner')
  el.className = `banner ${last.outcome.toLowerCase()}`
  U.setText('banner-kicker', `Night ${last.night} · ${result?.word ?? last.outcome}`)
  U.setText('banner-title', result?.title ?? (last.outcome === 'LIT' ? 'The fire caught!' : last.outcome === 'SMOKED' ? 'Up in smoke' : 'A cold night'))
  U.setText('banner-text', result?.text ?? '')
  U.setText('banner-names', result?.names ?? '')
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
    const from = L.historyFrom(n, 200)
    S.history = await client.history(from, 200)
    if (from === 1) S.ledger.complete = true
    renderHistory()
  } catch (e) {
    console.info('history', e?.message ?? e)
  }
}

// ---- the ledger ---------------------------------------------------------------------------------

const LEDGER_PAGE = 12

/** Every settled night the page has loaded, oldest first. */
const ledgerAll = () => L.mergeHistory(S.ledger.older, S.history)

function renderLedger() {
  if (!S.cfg || !S.state) return
  const dec = S.cfg.config.decimals
  const all = ledgerAll()
  const first = S.ledger.complete && all.length ? all[0].night : 1
  const rows = L.ledgerRows(all, S.ledger.details, first)
  const shown = rows.slice(0, S.ledger.shown)
  U.$('ledger').innerHTML = U.ledgerHtml(shown, { decimals: dec, explorer: EXPLORER, contract: client.contract, mock: MOCK })
  U.$('ledger-check').innerHTML = U.ledgerCheckHtml(L.ledgerCheck(S.cfg, S.state), { decimals: dec, symbol: S.cfg.config.symbol })
  U.$('ledger-events').innerHTML = U.ledgerEventsHtml({ explorer: EXPLORER, contract: client.contract, mock: MOCK })
  const settled = S.state.night - 1
  const more = shown.length < rows.length || (!S.ledger.complete && all.length > 0 && all[0].night > 1)
  U.$('btn-older').hidden = !more
  U.$('btn-older').disabled = S.ledger.loading
  U.setText('ledger-count', settled > 0 ? `${shown.length} of ${settled} night${settled === 1 ? '' : 's'}` : '')
  fetchDetails(shown)
}

/** The mint and burn split of the rows on screen, from night(n), for nights the contract still keeps. */
async function fetchDetails(rows) {
  const keep = Number(S.cfg.config.log_keep)
  const want = rows.map((r) => r.night).filter((n) => n > S.state.night - 1 - keep && !S.ledger.asked.has(n))
  if (!want.length) return
  want.forEach((n) => S.ledger.asked.add(n))
  let got = 0
  for (let i = 0; i < want.length; i += 3) {
    const views = await Promise.all(want.slice(i, i + 3).map((n) => client.night(n).catch(() => null)))
    for (const v of views) {
      if (!v || v.outcome === 'OPEN') continue
      S.ledger.details.set(v.night, v)
      got++
    }
  }
  if (got) renderLedger()
}

/** "Show older nights": the next page from what is loaded, else from history(from, limit). */
async function showOlder() {
  const all = ledgerAll()
  S.ledger.shown += LEDGER_PAGE
  if (S.ledger.shown > all.length && !S.ledger.complete && all.length && all[0].night > 1) {
    S.ledger.loading = true
    renderLedger()
    try {
      const { from, limit } = L.olderPage(all[0].night, Math.max(LEDGER_PAGE, 100))
      const page = (await client.history(from, limit)).filter((r) => r.night < all[0].night)
      S.ledger.older = L.mergeHistory(page, S.ledger.older)
      if (from === 1 || page.length < limit) S.ledger.complete = true
    } catch (e) {
      console.info('older history', e?.message ?? e)
      U.toast('Older nights are out of reach right now. Try again in a moment.', 'warn')
    } finally {
      S.ledger.loading = false
    }
  }
  renderLedger()
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

// ---- collecting for others ----------------------------------------------------------------------

/**
 * A settled night keeps its record until its last thrower collects. The page relays a few
 * collections per visit for throwers it sees in `recent_throws`, after checking they are owed.
 */
function scheduleHelp(ms) {
  clearTimeout(S.helpTimer)
  if (!client.canAct || S.helped >= HELP_COLLECTS_PER_VISIT) return
  S.helpTimer = setTimeout(helpCollect, ms)
}

async function helpCollect() {
  if (!S.state || !client.canAct) return
  // the player's own move goes first; look again in a little while
  if (queue.busy) return scheduleHelp(8_000)
  const me = client.identity?.account
  const left = HELP_COLLECTS_PER_VISIT - S.helped
  S.helped += await L.helpCollectRound({
    candidates: L.collectCandidates(S.recent, S.state.night, me, S.tried, 6),
    tried: S.tried,
    max: Math.min(2, left),
    pendingOf: async (account) => L.big((await client.holder(account)).pending),
    collect: (account) => client.collect(account),
    onError: (account, e) => console.info('collect for', account.slice(0, 12), e?.message ?? e),
  })
}

// ---- actions ------------------------------------------------------------------------------------

function onThrow(choice) {
  const m = S.model
  if (!m || !m.canThrow || !client.canAct) return
  sound.enable()
  const amount = choice.amount
  // name the night the chain's clock says now; `act` settles an ended night before the throw lands
  queue.push({ kind: 'throw', amount, night: clockNow(), build() {
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
  const night = clockNow()
  queue.push({ kind: 'kindling', build: () => L.kindlingAction(night) })
  U.$('btn-kindle').disabled = true
  renderYou()
}

function onCollect() {
  const m = S.model
  if (!m || m.pending <= 0n || !client.canAct) return
  sound.enable()
  const night = clockNow()
  queue.push({ kind: 'collect', build: () => L.collectAction(night) })
  U.$('btn-collect').disabled = true
  renderYou()
}

function onDone(out, item) {
  const m = S.model
  if (!out?.ok) {
    sound.refuse()
    U.toast(refusal(out?.error, item), 'warn', 6000)
  } else if (item.kind === 'kindling') {
    sound.chime()
    U.toast(`${L.fmtEmber(m.kindling, m.dec)} EMBER of kindling is yours. Throw some on the fire.`, 'ok')
  } else if (L.big(out.collected) > 0n) {
    sound.chime()
    U.toast(`${L.fmtEmber(out.collected, m.dec)} EMBER collected from your last night.`, 'ok')
  }
  U.$('btn-kindle').disabled = false
  U.$('btn-collect').disabled = false
  schedule(100)
}

function onError(err, item) {
  sound.refuse()
  const what = { throw: 'throw', kindling: 'claim', collect: 'collection' }[item.kind] ?? 'action'
  U.toast(err instanceof FriendlyError ? err.message : `That ${what} did not go through. Nothing was lost.`, 'warn', 6000)
  U.$('btn-kindle').disabled = false
  U.$('btn-collect').disabled = false
  schedule(100)
}

function refusal(error = '', item) {
  if (/is for night/.test(error)) return item.kind === 'throw' ? 'Dawn came first. Your wood is still yours: throw it on tonight’s fire.' : 'Dawn came first. Try again for tonight.'
  if (/handed out/.test(error)) return 'Tonight’s kindling is handed out. Come back next night.'
  if (/never held/.test(error)) return 'Kindling is only for newcomers, and this account already has EMBER.'
  if (/not enough/.test(error)) return 'Not enough free EMBER for that throw.'
  if (/smallest throw/.test(error)) return 'That throw is below the smallest one the fire takes.'
  return `The fire keeper said no: ${error}`
}

// ---- the share preview, from estimate(amount) -----------------------------------------------------

/** Asks the contract what the selected throw would weigh now; at most one request in flight. */
async function refreshEstimate() {
  const m = S.model
  const c = selectedChoice()
  if (!m || !c || m.due || S.estimating) return
  const key = `${c.amount}|${m.pile}|${m.windows.current}|${m.night}`
  if (S.estimate?.key === key) return
  S.estimating = key
  try {
    const est = await client.estimate(c.amount)
    S.estimate = { key, est }
  } catch {
    S.estimate = { key, est: L.estimateLocal({ cfg: S.cfg, state: S.state, amount: c.amount, nowMs: chainNow() }) }
  } finally {
    S.estimating = null
  }
  hint()
}

function selectedChoice() {
  const choices = S.choices ?? []
  if (!choices.length) return null
  return choices[S.selected ?? Math.min(1, choices.length - 1)] ?? choices[0]
}

// ---- render -------------------------------------------------------------------------------------

function render() {
  if (!S.cfg || !S.state) return
  S.model = L.deriveModel({ cfg: S.cfg, state: S.state, holder: S.holder, nowMs: chainNow() })
  const m = S.model
  const me = client.identity?.account
  const f = (u) => L.fmtEmber(u, m.dec)
  const w = (u) => L.fmtWhole(u, m.dec)
  if (!S.replaying) scene.setNight({
    progress: m.progress,
    pct: m.pct,
    reached: m.reached,
    pileText: m.pile > 0n ? `${w(m.pile)} on the pile` : '',
    pileShort: m.pile > 0n ? w(m.pile) : '',
    targetText: m.reached ? `✓ ${w(m.target)} reached` : `${w(m.target)} needed`,
  })
  sound.setHeat(scene.heat)

  // people around the fire: tonight's throwers as recent_throws names them, and the player
  const list = L.throwersFromRecent(S.recent, m.night, me, m.myWood)
  S.nightThrowers = { night: m.night, list }
  const held = S.seatHold && Date.now() < S.seatHold.until && list.length < S.seatHold.list.length
  const { shown, more } = L.seats(held ? S.seatHold.list : list, me, phone() ? 8 : 10, held ? 0 : m.throwers)
  scene.setSeats(shown, more)
  U.$('scene').setAttribute('aria-label', `Night ${m.night}: ${w(m.pile)} of ${w(m.target)} EMBER on the pile, ${m.throwers} throwers.`)

  // tonight
  const h = L.headline(m)
  U.setText('need-big', h.big)
  U.setText('need-small', h.small)
  U.$('meter-fill').style.setProperty('--p', `${(Math.min(1, m.pct) * 100).toFixed(1)}%`)
  U.$('meter').classList.toggle('reached', m.reached)
  U.$('meter').setAttribute('aria-valuenow', String(Math.round(m.pct * 100)))
  U.setText('pile-num', w(m.pile))
  U.setText('target-num', w(m.target))
  U.setText('throwers', String(m.throwers))
  U.setText('streak', m.streak === 1 ? '1 night' : `${m.streak} nights`)
  U.setText('hearth', L.fmtEmber(m.hearth, m.dec, { compact: true }))
  U.setText('firestarter', m.firestarter ? L.nameOf(m.firestarter, me, BOTS) : 'nobody yet')
  U.$('firestarter').classList.toggle('muted', !m.firestarter)
  U.setText('last-log', m.lastLog ? `${L.nameOf(m.lastLog.account, me, BOTS)} · ${f(m.lastLog.amount)}` : m.reached ? '–' : 'not yet')
  U.$('last-log').classList.toggle('muted', !m.lastLog)
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
  if (S.noteCountsDown) U.setText('note', L.kindlingNote('gone', left))
  if (scene) scene.progress = Math.min(1, Math.max(0, (now - m.start) / m.nightMs))
  const win = L.windowsModel({ cfg: S.cfg, state: S.state, holder: S.holder, nowMs: now })
  U.renderQuarters(U.$('quarters'), win, now)
  U.renderWindows(U.$('windows'), win, now, { decimals: m.dec })
  U.setText('early', win.due ? '–' : L.fmtFactor(win.nowFactorBp))
  U.setText('window-closes', win.due ? 'The night is over.' : `Quarter ${win.current + 1} of ${win.count} closes in ${L.fmtCountdown(win.closesInMs)}.`)
  if (win.current !== S.windowSeen) {
    S.windowSeen = win.current
    refreshEstimate()
  }
}

function renderYou() {
  const m = S.model
  if (!m) return
  const f = (u) => L.fmtEmber(u, m.dec)
  const pending = queue?.pendingWood() ?? 0n
  const balance = m.balance > pending ? m.balance - pending : 0n
  U.setText('balance', S.holder ? f(balance) : '–')
  U.setText('my-wood', f(m.myWood + pending))
  const share = U.$('my-share')
  if (m.myWood > 0n) {
    share.textContent = `+${f(m.reward)} new`
    share.className = 'good'
  } else {
    share.textContent = pending > 0n ? 'counting…' : '–'
    share.className = ''
  }
  const canAct = client.canAct && S.canSign

  // credit from a settled night
  const ready = U.$('ready')
  ready.hidden = !(m.pending > 0n && m.readyNight)
  if (!ready.hidden) {
    U.setText('ready-amount', `+${f(m.pending)}`)
    U.setText('ready-text', L.readyText(m))
    U.$('btn-collect').disabled = !canAct || queue.busy
  }

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
      b.addEventListener('pointerenter', () => select(i))
      b.addEventListener('focus', () => select(i))
      row.appendChild(b)
    })
    row.hidden = !choices.length
  }
  S.choices = choices
  hint()

  let note = ''
  if (!S.canSign) note = 'This browser cannot make a signing key (Ed25519). Chrome 137, Safari 17 or Firefox 130 and newer can.'
  else if (!client.canAct) note = 'Watching only for now: the public gas pool that pays for moves is not funded yet.'
  else if (!showKindle && m.balance === 0n && m.myWood === 0n) {
    note = L.kindlingNote(m.kindle.why, m.msLeft)
  } else if (m.due) note = 'Dawn is breaking. Throws open again in a moment.'
  S.noteCountsDown = note !== '' && note === L.kindlingNote('gone', m.msLeft)
  showNote(note)

  const st = U.$('status')
  const inflight = queue?.inflight
  st.textContent = inflight ? { throw: `Throwing ${inflight.amount ? f(inflight.amount) : ''} EMBER…`, kindling: 'Fetching kindling…', collect: 'Collecting…' }[inflight.kind] : ''
  st.classList.toggle('busy', !!inflight)
}

function select(i) {
  if (S.selected === i) return
  S.selected = i
  hint()
  refreshEstimate()
}

function hint() {
  const m = S.model
  const el = U.$('throw-hint')
  const c = selectedChoice()
  // the chip the hint describes is marked, so the hint never seems to speak of another one
  for (const [i, b] of [...U.$('throw-row').children].entries()) b.classList.toggle('selected', !!c && S.choices[i] === c && !!m?.canThrow)
  if (!m || !c || !m.canThrow) {
    el.textContent = ''
    return
  }
  const est = S.estimate?.est && L.big(S.estimate.est.amount) === c.amount ? S.estimate.est : L.estimateLocal({ cfg: S.cfg, state: S.state, amount: c.amount, nowMs: chainNow() })
  el.textContent = L.throwHint(m, c.amount, L.previewFromEstimate(m, est, S.cfg))
}

function showNote(text) {
  const n = U.$('note')
  n.textContent = text
  n.hidden = !text
}

function renderHistory() {
  const dec = S.cfg.config.decimals
  const sym = S.cfg.config.symbol
  const strip = L.nightStrip(S.history, 24)
  U.renderStrip(U.$('strip'), strip, { decimals: dec, symbol: sym })
  U.setText('strip-word', strip.length ? strip[strip.length - 1].word : '')
  U.renderChart(U.$('chart'), L.supplySeries(S.history, dec), { symbol: sym })
  renderLedger()
}

function renderRecords() {
  const r = S.state?.records
  if (!r) return
  const dec = S.cfg.config.decimals
  U.setText('rec-streak', r.longest_streak === 1 ? '1 night' : `${r.longest_streak} nights`)
  U.setText('rec-tallest', L.big(r.tallest_fire) > 0n ? L.fmtWhole(r.tallest_fire, dec) : '–')
  U.setText('rec-minted', L.fmtEmber(r.total_minted, dec, { compact: true }))
  U.setText('rec-burned', L.fmtEmber(r.total_burned, dec, { compact: true }))
  U.setText('tally', `${r.nights_lit} lit · ${r.nights_smoked} smoked · ${r.nights_cold} cold · ${r.kindling_claims} kindling claim${r.kindling_claims === 1 ? '' : 's'}`)
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
      deployment: DEPLOYMENT.name,
      contract: client?.contract ?? CONTRACT,
      keys: S.keys,
      codeHash: S.codeHash,
      expectedHash: MOCK ? null : CODE_HASH,
      account: client?.identity?.account ?? '–',
      gasAccount: GAS_ACCOUNT,
      rpcHost: client?.rpc?.host ?? '–',
      txs: client?.txs ?? [],
      explorer: EXPLORER,
      deployed: S.deployed,
      owed: S.state ? { amount: L.fmtEmber(S.state.owed, S.cfg.config.decimals), nights: S.state.owed_nights } : null,
    })
  U.openDrawer('Proof', draw())
  if (S.keys === null && client) {
    try {
      S.keys = await client.accessKeys()
      const acc = await client.viewAccount()
      S.codeHash = acc?.code_hash ?? null
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
