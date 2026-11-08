// The page controller: boots the scene, reads the contract, settles nights that are due, collects
// what settled nights owe, turns taps into signed actions and the chain's answers into pictures.
//
// Mock mode runs only with `?mock=1` in the URL; without it the page talks to NEAR testnet and shows
// nothing that did not come from the chain.
import { ed25519Supported } from './near.js'
import { ActionQueue, Client, FriendlyError, loadOrCreateIdentity, notDeployed } from './chain.js'
import { BOTS, CODE_HASH, CONTRACT, DEPLOYMENT, EXPLORER, GAS_ACCOUNT, HELP_COLLECTS_PER_VISIT, PLAY_URL } from './config.js'
import { Scene } from './scene.js'
import { Sound } from './audio.js'
import * as L from './logic.js'
import * as U from './ui.js'
import { shareCard } from './card.js'

const params = new URLSearchParams(location.search)
const MOCK = params.get('mock') === '1'
const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
const phone = () => window.matchMedia('(max-width: 900px)').matches

/** localStorage that never throws (private windows may refuse it; then the page just forgets). */
const store = L.safeStore(() => globalThis.localStorage)
const INTRO_KEY = MOCK ? 'bonfire:mock-intro:v1' : 'bonfire:intro:v1'
const REPLAY_KEY = MOCK ? 'bonfire:mock-replay:v1' : 'bonfire:replay:v1' // last night was played back once
const BANNER_MS = 9000
const STAMP_MS = 1700

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
  replaying: false, // the playback owns the scene's pile until the film ends
  film: null, // the first visit's film of last night while it plays: { end() }
  filmWanted: false, // a first visit in this browser, with motion allowed
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
  card: null, // the night shown in the banner, when the player threw on it (Share your card)
  myCard: null, // the player's last settled night, kept in "Your wood" until their next throw
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
  introWanted: false, // a first visit: the three steps show once the replay is over
  intro: null, // null | 'on' | 'done'
  tallyKey: null, // localStorage key of the player's tally (tallySee)
  tally: null,
  tallySaved: null,
  tallyBusy: false,
  baseTitle: document.title, // the tab's title while it is visible
  dawn: null, // the player's own dawn line (L.dawnLine), while they have wood tonight
  dawnArmed: null, // the night whose dawn rings the chime (L.dawnCue)
  tabResult: null, // the player's result, kept in the tab title until the tab is looked at again
  lateHint: false, // the hint says tonight is out of reach, with a countdown to the next night
}

let client
let scene
let queue
const sound = new Sound(store)

// ---- boot ---------------------------------------------------------------------------------------

async function boot() {
  scene = new Scene(U.$('scene'), { reducedMotion: reduced })
  // a first visit shows last night as a short film: tonight's cards wait off screen until it is over
  S.filmWanted = !reduced && !store.get(REPLAY_KEY)
  if (S.filmWanted) document.body.classList.add('film-wait')
  layout()
  scene.setNight({ progress: 0.35, pct: 0, reached: false, pileText: '', targetText: '' })
  scene.start()
  window.addEventListener('resize', layout)
  document.fonts?.load('800 16px "Bonfire Display"').catch(() => {})
  document.fonts?.ready.then(layout) // the rules may wrap differently once the fonts are in
  if (globalThis.ResizeObserver) {
    // the cards change height as the night goes on: the moon, the circle and the strip follow
    const ro = new ResizeObserver(() => layout())
    ro.observe(U.$('you'))
    ro.observe(U.$('tonight'))
  }
  wire()

  if (MOCK) {
    const { MockClient } = await import('./mock.js')
    const nightS = Number(params.get('night')) || 300
    client = new MockClient({ scene: params.get('scene') || 'live', nightMs: Math.max(20, nightS) * 1000, contract: CONTRACT })
    U.$('mock-badge').hidden = false
    document.title = 'MOCK · ' + document.title
    S.baseTitle = document.title
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
  if (identity) {
    S.holder = await client.setIdentity(identity).catch(() => null)
    S.tallyKey = `bonfire:tally:v1:${MOCK ? 'mock:' : ''}${client.contract}:${identity.account}`
    S.tally = loadTally()
  }
  S.phase = 'live'
  document.body.classList.add('live')
  await poll()
  loadHistory()
  loadIcon()
  setInterval(tickClock, 250)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) S.tabResult = null
    renderTitle()
    schedule(document.hidden ? 8000 : 300)
  })
  scheduleHelp(25_000)
}

function bootFailed(e) {
  console.info('boot', e?.message ?? e)
  document.body.classList.remove('film-wait')
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

/**
 * The scene's layout from the page around it: the stretch of the stage between the cards (the fire's
 * circle, its labels and the strip stay inside it), the moon's path beside the text, and how high a
 * roar may reach.
 */
function layout() {
  const stage = U.$('stage')?.getBoundingClientRect()
  if (!stage?.width) return
  const rel = (r) => r && { left: r.left - stage.left, right: r.right - stage.left, top: r.top - stage.top, bottom: r.bottom - stage.top }
  const text = rel(document.querySelector('.rules')?.getBoundingClientRect())
  const clock = rel(U.$('clock')?.getBoundingClientRect())
  const sky = text && clock ? { left: Math.min(text.left, clock.left), right: Math.max(text.right, clock.right), top: clock.top, bottom: Math.max(text.bottom, clock.bottom) } : null
  const small = phone()
  const you = small ? null : rel(U.$('you').getBoundingClientRect())
  const tonight = small ? null : rel(U.$('tonight').getBoundingClientRect())
  const free = you && tonight ? { l: tonight.right + 12, r: you.left - 12 } : null
  const r = scene.moonRadius?.() ?? 20
  const top = rel(document.querySelector('.top')?.getBoundingClientRect())?.bottom ?? 60
  scene.setLayout({
    cx: 0.5,
    by: small ? 0.82 : 0.76,
    scale: small ? 1.28 : 1.12,
    free,
    moon: L.moonPath({ W: stage.width, H: stage.height, text: sky, card: you, top, r }),
    // under the rules while they are on the sky; up to the clock (phones: under it) while the stamp,
    // the banner or the film have taken their place
    flameTop: (sky?.bottom ?? 220) + 14,
    flameTopOpen: small ? (clock?.bottom ?? 130) + 8 : (clock?.top ?? 60) + 16,
  })
  fitStrip(free, you, tonight)
}

/** The sky is free of the clock and the rules while the film, the stamp or the banner hold it. */
function syncSky() {
  if (scene) scene.skyOpen = ['replay-on', 'stamp-on', 'banner-on'].some((c) => document.body.classList.contains(c))
}

/** The strip of last nights fits between the cards wherever they reach down to it: older nights go first. */
function fitStrip(free = null, you = null, tonight = null) {
  const row = document.querySelector('.strip-row')
  const items = [...U.$('strip').children]
  for (const li of items) li.hidden = false
  if (!row || !free || items.length < 2) return
  const stage = U.$('stage').getBoundingClientRect()
  const top = row.getBoundingClientRect().top - stage.top - 8
  const intro = U.$('intro')
  const introBottom = intro && !intro.hidden ? intro.getBoundingClientRect().bottom - stage.top : 0
  if (Math.max(you?.bottom ?? 0, tonight?.bottom ?? 0, introBottom) < top) return
  const room = 2 * Math.min(stage.width / 2 - free.l, free.r - stage.width / 2)
  for (let i = 0; i < items.length - 6 && row.getBoundingClientRect().width > room; i++) items[i].hidden = true
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
    soundTip(false)
    renderSound()
  })
  U.$('btn-kindle').addEventListener('click', onKindle)
  U.$('btn-collect').addEventListener('click', onCollect)
  U.$('banner-card').addEventListener('click', () => onShare(S.card))
  U.$('btn-share').addEventListener('click', () => onShare(S.myCard))
  U.$('banner-go').addEventListener('click', () => S.film?.end())
  U.$('film-skip').addEventListener('click', () => S.film?.end())
  U.$('btn-older').addEventListener('click', showOlder)
  U.$('drawer-close').addEventListener('click', U.closeDrawer)
  U.$('drawer-body').addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-cheat]')
    if (b && !b.disabled) onCheat(b.dataset.cheat)
  })
  U.$('drawer-backdrop').addEventListener('click', U.closeDrawer)
  U.$('intro-close').addEventListener('click', endIntro)
  U.$('intro-proof').addEventListener('click', openProof)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (U.drawerOpen()) U.closeDrawer()
    else if (S.film) S.film.end()
    else if (S.intro === 'on' && U.$('intro').contains(document.activeElement)) endIntro()
  })
  renderSound()
}

function renderSound() {
  const b = U.$('btn-sound')
  b.setAttribute('aria-pressed', String(sound.on))
  b.setAttribute('aria-label', sound.on ? 'Sound is on' : 'Sound is off')
  b.querySelector('.ico').classList.toggle('off', !sound.on)
  U.setText('sound-word', sound.on ? 'Sound on' : 'Sound off')
}

let soundTipTimer = null
/** A ring around the speaker for a few seconds after the sound came on by itself. */
function soundTip(show) {
  clearTimeout(soundTipTimer)
  S.soundNews = show
  U.$('btn-sound').classList.toggle('ring', show && !reduced)
  if (show) soundTipTimer = setTimeout(() => soundTip(false), 6000)
}

/** Shares the card of a night the player threw on: the PNG through the share sheet where there is one, else a download. */
async function onShare(result) {
  if (!result || !S.cfg) return
  const how = await shareCard({ result, icon: S.icon, symbol: S.cfg.config.symbol, decimals: S.cfg.config.decimals, seats: scene?.seats ?? [], url: PLAY_URL }).catch(() => false)
  if (how === 'saved') U.toast('Your card is saved. Share it anywhere.', 'ok')
  else if (!how) U.toast('The card could not be made in this browser.', 'warn')
}

/** The player's last night stays in "Your wood", with its card, until their next throw. */
function renderMyCard() {
  const c = S.myCard
  U.$('my-card').hidden = !c
  if (!c) return
  U.$('my-card').classList.toggle('smoked', c.outcome !== 'LIT')
  U.setText('my-card-word', `Night ${c.night} · ${c.word}`)
  U.setText('my-card-line', c.outcome === 'LIT' ? (c.throwers > 1 ? `${c.throwers} of you lit it.` : 'You lit it.') : 'It went up in smoke.')
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
    noteTally()
    const lastNight = state.last?.night ?? 0
    if (S.lastSettled === null) {
      S.lastSettled = lastNight
      // a first visit: a newcomer who has not hidden the steps before, and who can play
      S.introWanted = store.get(INTRO_KEY) === null && S.canSign && client.canAct && !S.holder?.held
      // after this poll's render, which makes the model the steps read
      setTimeout(() => (S.filmWanted && replayLastNight(state.last)) || filmOver(), S.filmWanted ? 500 : 0)
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
 * The payoff at first sight: on a first visit in this browser, last night plays back as a short
 * film (its pile rising against its target, then dawn: the stamp and the banner), so a visitor sees
 * what a night is without waiting for this one to end. Nothing of tonight is on screen meanwhile, so
 * two nights never show at once; "Skip" ends it at any moment. It reads state.last and night(n);
 * nothing is sent. Returns whether it plays.
 */
function replayLastNight(last) {
  if (S.replayed || !L.replayWanted({ seen: store.get(REPLAY_KEY), reduced, last, night: S.state?.night }) || S.state?.last?.night !== last.night) return false
  const pile = BigInt(last.pile ?? 0)
  const target = BigInt(last.target ?? 0)
  S.replayed = true
  S.replaying = true
  store.set(REPLAY_KEY, String(Date.now()))
  document.body.classList.add('replay-on')
  document.body.classList.remove('film-wait')
  syncSky()
  U.setText('film-kicker', `Replay of last night · Night ${last.night}`)
  const film = U.$('film')
  film.classList.remove('out')
  film.hidden = false
  const w = (u) => L.fmtWhole(u, S.cfg.config.decimals)
  const timers = []
  const later = (ms, fn) => timers.push(setTimeout(fn, ms))
  let raf = 0
  let over = false
  S.film = {
    end() {
      if (over) return
      over = true
      cancelAnimationFrame(raf)
      timers.forEach(clearTimeout)
      S.film = null
      // a live dawn that came meanwhile keeps its banner; the film's own banner goes
      if (S.lastSettled === last.night) hideBanner()
      hideStamp()
      film.hidden = true
      U.$('banner-go').hidden = true
      S.replaying = false
      document.body.classList.remove('replay-on')
      syncSky()
      render()
      filmOver()
    },
  }
  const t0 = performance.now()
  const step = () => {
    const f = Math.min(1, (performance.now() - t0) / 4200)
    const p = (pile * BigInt(Math.round(f * 1000))) / 1000n
    const reached = p >= target
    scene.setNight({
      progress: f,
      pct: Number((p * 1000n) / target) / 1000,
      reached,
      pileText: p > 0n ? `${w(p)} on the pile` : '',
      pileShort: p > 0n ? w(p) : '',
      targetText: reached ? `✓ ${w(target)} reached` : `target ${w(target)}`,
    })
    if (f < 1) return void (raf = requestAnimationFrame(step))
    scene.outcome(last.outcome)
    film.classList.add('out')
    client
      .night(last.night)
      .then((n) => L.nightResult(n, S.holder, client.identity?.account, S.cfg.config.decimals, S.cfg.config.symbol, BOTS))
      .catch(() => null)
      .then((result) => {
        if (over) return
        film.hidden = true
        // a dawn that came during the playback has its own banner up: the replay does not cover it
        if (S.lastSettled !== last.night) return later(1500, () => S.film?.end())
        stageDawn(last, result, { replay: true })
        later(STAMP_MS + 4200, () => S.film?.end())
      })
  }
  raf = requestAnimationFrame(step)
  return true
}

/** The film is over (or never played): tonight's cards come in, then the first visit's steps. */
function filmOver() {
  document.body.classList.remove('film-wait')
  layout()
  showIntro()
}

// ---- a first visit: three steps, numbered on the controls they point at --------------------------

function showIntro() {
  if (!S.introWanted || S.intro || !S.model) return
  S.intro = 'on'
  U.setText('intro-title', `A whole night in ${L.fmtDuration(S.model.nightMs)}`)
  U.$('intro').hidden = false
  renderIntro()
  layout()
}

function renderIntro() {
  const on = S.intro === 'on' && !!S.model
  document.body.classList.toggle('intro-on', on)
  if (!on) return
  const now = chainNow() // the third step counts down with the clock, between polls too
  const m = { ...S.model, msLeft: Math.max(0, S.model.end - now), due: S.model.due || now >= S.model.end }
  const { at, steps } = L.introSteps(m, queue?.pendingWood() ?? 0n)
  for (const k of [1, 2, 3]) document.body.classList.toggle(`intro-at-${k}`, at === k)
  const items = U.$('intro-steps').children
  steps.forEach((st, i) => {
    const li = items[i]
    if (li.className !== st.state) li.className = st.state
    if (st.state === 'now') li.setAttribute('aria-current', 'step')
    else li.removeAttribute('aria-current')
    const [num, title, sub, sr] = li.children
    const mark = st.state === 'done' ? '✓' : String(st.n)
    if (num.textContent !== mark) num.textContent = mark
    if (title.textContent !== st.title) title.textContent = st.title
    if (sub.textContent !== st.sub) sub.textContent = st.sub
    const said = st.state === 'done' ? ' (done)' : ''
    if (sr.textContent !== said) sr.textContent = said
  })
}

/** Hidden for good: by the player, or once the night the player threw on has settled. */
function endIntro() {
  if (S.intro !== 'on') return
  S.intro = 'done'
  store.set(INTRO_KEY, String(Date.now()))
  const focused = U.$('intro').contains(document.activeElement)
  U.$('intro').hidden = true
  layout()
  for (const c of ['intro-on', 'intro-at-1', 'intro-at-2', 'intro-at-3']) document.body.classList.remove(c)
  if (focused) [U.$('btn-kindle'), ...U.$('throw-row').querySelectorAll('button'), U.$('btn-collect')].find((b) => b && !b.disabled && b.offsetParent)?.focus()
}

// ---- the player's own tally, from what this page saw ----------------------------------------------

function loadTally() {
  try {
    return JSON.parse(store.get(S.tallyKey) ?? 'null')
  } catch {
    return null
  }
}

function saveTally(t) {
  S.tally = t
  const text = JSON.stringify(t)
  if (text === S.tallySaved) return
  S.tallySaved = text
  store.set(S.tallyKey, text)
}

/** A settled night's outcome, where the page has it. */
const outcomeOf = (n) => S.history.find((r) => r.night === n)?.outcome ?? (S.state?.last?.night === n ? S.state.last.outcome : null)

function noteTally() {
  if (!S.tallyKey || !S.holder || !S.state) return
  saveTally(L.tallySee(S.tally, S.holder, S.state.night, outcomeOf))
  resolveTally()
}

/** Nights the page saw wood on but not their payout (collected while it was closed): from night(n). */
async function resolveTally() {
  // the holder's own night settles from holder(me) on the next poll
  const open = L.tallyOpen(S.tally, S.state.night).filter((n) => n !== S.holder?.wood_night)
  if (S.tallyBusy || !open.length) return
  S.tallyBusy = true
  try {
    for (const n of open.slice(0, 3)) {
      let view
      try {
        view = await client.night(n)
      } catch {
        break // try again on a later poll
      }
      saveTally(L.tallyResolve(S.tally, n, view, outcomeOf(n)))
    }
  } finally {
    S.tallyBusy = false
  }
  renderTally()
}

function renderTally() {
  const sum = S.cfg ? L.tallySummary(S.tally, S.cfg.config.decimals, S.cfg.config.symbol) : null
  U.$('my-tally').hidden = !sum
  if (sum) U.setText('my-tally', sum.text)
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
  if (S.film) S.film.end() // a live dawn ends the film of last night
  stageDawn(last, result)
  if (result?.mine) {
    S.myCard = result
    renderMyCard()
  }
  if (result?.mine && document.hidden) {
    S.tabResult = result.title
    renderTitle()
  }
  if (result?.mine) endIntro() // the first night is played: the banner is the third step
  loadHistory()
  loadIcon()
  scheduleHelp(15_000 + Math.random() * 15_000)
}

/**
 * Dawn on stage: the scene has started the roar or the smoke; a stamp with the coin face's word fills
 * the sky where the clock was, then the banner takes its place, then the clock comes back.
 */
function stageDawn(last, result, { replay = false } = {}) {
  clearTimeout(S.stampTimer)
  hideBanner()
  const st = L.stampFor(last.outcome, result?.word ?? '')
  if (st) {
    const el = U.$('stamp')
    el.textContent = st.text
    el.className = `stamp ${st.kind}`
    el.hidden = false
    document.body.classList.add('stamp-on')
    syncSky()
    S.stampTimer = setTimeout(() => {
      el.classList.add('out')
      S.stampTimer = setTimeout(hideStamp, 350)
      showBanner(last, result, { replay })
    }, STAMP_MS)
  } else showBanner(last, result, { replay })
}

function hideStamp() {
  clearTimeout(S.stampTimer)
  U.$('stamp').hidden = true
  document.body.classList.remove('stamp-on')
  syncSky()
}

function showBanner(last, result, { replay = false } = {}) {
  const el = U.$('banner')
  el.className = `banner ${last.outcome.toLowerCase()}`
  const word = result?.word ?? last.outcome
  U.setText('banner-kicker', replay ? `Replay of last night · Night ${last.night} · ${word}` : `Night ${last.night} · ${word}`)
  U.setText('banner-title', result?.title ?? (last.outcome === 'LIT' ? 'The fire caught!' : last.outcome === 'SMOKED' ? 'Up in smoke' : 'A cold night'))
  U.setText('banner-text', result?.text ?? '')
  U.setText('banner-names', result?.names ?? '')
  // a night the player threw on gets a card to share; it stays in "Your wood" after the banner goes
  S.card = !replay && result?.mine ? result : null
  U.$('banner-card').hidden = !S.card
  U.$('banner-go').hidden = !replay
  el.hidden = false
  document.body.classList.add('banner-on')
  syncSky()
  clearTimeout(S.bannerTimer)
  if (!replay) S.bannerTimer = setTimeout(hideBanner, BANNER_MS)
}

function hideBanner() {
  clearTimeout(S.bannerTimer)
  U.$('banner').hidden = true
  document.body.classList.remove('banner-on')
  syncSky()
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
  if (S.myCard) {
    S.myCard = null // a new night of their own: the last one's card steps aside
    renderMyCard()
  }
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
  // the tap is the gesture browsers wait for: the fire is heard from here on, unless muted before
  if (L.soundOnFirstTap(sound.choice)) {
    sound.setOn(true)
    renderSound()
    soundTip(true)
  }
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

/** "Try to cheat it": a real act that breaks a rule, so the contract's refusal can be seen. */
function onCheat(what) {
  if (!client?.canAct) return
  sound.enable()
  const night = clockNow()
  const build = what === 'future' ? () => L.throwAction(S.cfg.config.min_throw, night + 1) : () => L.kindlingAction(night)
  queue.push({ kind: 'cheat', what, build })
  U.toast('Sent. Waiting for the contract’s answer…', '', 3000)
}

function onDone(out, item) {
  const m = S.model
  if (item.kind === 'cheat') {
    if (out?.ok) U.toast('That went through, which it should not have. Please report it.', 'warn', 8000)
    else U.toast(`Refused, as it should be. The contract said: “${out?.error ?? 'no'}”`, 'ok', 8000)
    schedule(100) // client.onTx has already redrawn an open Proof drawer with the new transaction
    return
  }
  if (!out?.ok) {
    sound.refuse()
    U.toast(refusal(out?.error, item), 'warn', 6000)
  } else if (item.kind === 'kindling') {
    sound.chime()
    const news = S.soundNews ? ` Sound is on: the speaker ${phone() ? 'at the top' : 'up right'} mutes it.` : ''
    U.toast(`${L.fmtEmber(m.kindling, m.dec)} EMBER of kindling is yours. Throw some on the fire.${news}`, 'ok', news ? 6500 : 4200)
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
    targetText: m.reached ? `✓ ${w(m.target)} reached` : `target ${w(m.target)}`,
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
  U.setText('tonight-night', ` · Night ${m.night}`)
  U.setText('pile-num', w(m.pile))
  U.setText('target-num', w(m.target))
  U.setText('throwers', String(m.throwers))
  U.setText('streak', m.streak === 1 ? '1 night' : `${m.streak} nights`)
  U.setText('hearth', L.fmtEmber(m.hearth, m.dec, { compact: true }))
  U.setText('firestarter', m.firestarter ? L.nameOf(m.firestarter, me, BOTS) : 'nobody yet')
  U.$('firestarter').classList.toggle('muted', !m.firestarter)
  // until someone reaches the target, the line says what the title is for, not "not yet" (which read
  // like the player's own log had not landed)
  U.setText('last-log', m.lastLog ? `${L.nameOf(m.lastLog.account, me, BOTS)} · ${f(m.lastLog.amount)}` : m.reached ? '–' : `whoever reaches ${w(m.target)}`)
  U.$('last-log').classList.toggle('muted', !m.lastLog)
  U.setText('kindling-left', m.kindlingLeft > 0 ? `Kindling left tonight: ${m.kindlingLeft} of ${m.kindlingPerNight}` : 'No kindling left tonight')
  const risk = L.streakRisk(m)
  if (U.$('risk').hidden !== !risk) {
    U.$('risk').hidden = !risk
    layout() // the moon's path stays under the text above it
  }
  if (risk) U.setText('risk', risk.text)
  renderYou()
  renderTally()
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
  if (S.lateHint) hint()
  renderIntro()
  renderDawn(now)
}

/** The player's own dawn: the line under their wood, the tab title while hidden, a chime at dawn. */
function renderDawn(now) {
  const m = S.model
  const dawn = L.dawnLine({ ...m, msLeft: Math.max(0, m.end - now), due: m.due || now >= m.end }, queue?.pendingWood() ?? 0n)
  U.$('dawn-line').hidden = !dawn
  if (dawn) {
    U.setText('dawn-when', dawn.when)
    U.setText('dawn-what', dawn.what)
    U.$('dawn-line').classList.toggle('due', dawn.due)
  }
  const cue = L.dawnCue(S.dawnArmed, m.night, dawn)
  S.dawnArmed = cue.armed
  if (cue.ring) sound.chime() // silent unless sound is on (Sound plays nothing while off)
  S.dawn = dawn
  renderTitle()
}

function renderTitle() {
  const t = L.tabTitle(S.baseTitle, { hidden: document.hidden, dawn: S.dawn, result: S.tabResult })
  if (document.title !== t) document.title = t
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
  U.setText('kindle-sub', `Start playing · ${f(m.kindling)} free EMBER · no wallet`)
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
  renderIntro()
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
    S.lateHint = false
    return
  }
  const est = S.estimate?.est && L.big(S.estimate.est.amount) === c.amount ? S.estimate.est : L.estimateLocal({ cfg: S.cfg, state: S.state, amount: c.amount, nowMs: chainNow() })
  // the clock between polls, so a hint that counts down to the next night ticks with the clock
  const now = { ...m, msLeft: Math.max(0, m.end - chainNow()) }
  S.lateHint = !!L.outOfReach(now)
  U.setText('throw-hint', L.throwHint(now, c.amount, L.previewFromEstimate(now, est, S.cfg)))
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
  layout()
  const flows = L.flowSeries(S.history, dec, phone() ? 36 : 60)
  U.renderFlows(U.$('chart'), flows, { symbol: sym })
  // the net change over the nights shown, in EMBER: a percentage of the hearth-heavy supply reads as zero
  const net = flows.reduce((a, d) => a + d.mint - d.burn, 0)
  const now = S.history.length ? L.fmtWhole(S.history[S.history.length - 1].supply, dec) : ''
  U.setText('supply-now', now ? `Supply ${now} ${sym} · ${net >= 0 ? '+' : '−'}${L.fmtInt(Math.round(Math.abs(net)))} over ${flows.length} night${flows.length === 1 ? '' : 's'}` : '')
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
  const hc = L.headcount({ founders: S.cfg.founders ?? [], labels: BOTS, kindlingClaims: r.kindling_claims, meKindled: !!S.holder?.kindled })
  U.setText('headcount', hc.text)
  U.$('headcount').hidden = false
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
      cheats: { canAct: Boolean(client?.canAct), kindlingTwice: S.model?.kindle.why === 'claimed' },
      lockTx: DEPLOYMENT.lockTx ?? null,
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
