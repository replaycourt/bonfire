#!/usr/bin/env node
// Plans the nights of the demo recording: which `--seed` for scripts/bots.mjs gives the night we want
// on camera. It replays exactly what bots.mjs would do (its own planNight and decide, its random
// streams, its night layout) together with the visitor's planned throws, settles every night with the
// model in scripts/bonfire-lib.mjs, and scores seeds. Nothing is sent; it only reads the chain.
//
//   node demo/video/tools/plan.mjs bonfire-coin.testnet --nights 5 --smoke 2 --visitor 1:22:100,2:25:25
//        [--start <night>] [--target <EMBER>] [--streak <n>] [--seeds 1-200000] [--show <seed>] [--top 8]
//
// --visitor  the visitor's throws: <run night>:<seconds into the night>:<EMBER>, comma separated
// --start    the first night of the bots' run (default: the next night that bots.mjs would start on)
// --target / --streak   the fire as it will be when the run starts (default: read from state(); if
//            the open night is already lit, the target grows as it will at dawn)
// --show     print the predicted nights of one seed, throw by throw
//
// The bot keys are not needed: the bots' order is the order of BONFIRE_BOTS (which must be set, as
// for bots.mjs), and only their labels are printed. The score wants: the visitor throws first on the
// run's first night, the first window ends below the target, the last log is the late bot (the
// sniper closes the gap) or else the steady bot; the smoke night smokes; every other night is lit.
import { join } from 'node:path'
import { BEHAVIOURS, botsFromSecret, decide, planNight } from '../../../scripts/bots.mjs'
import { EMBER, ROOT, creditOf, ember, readJson, settleNight, windowAt } from '../../../scripts/bonfire-lib.mjs'
import { view } from '../../../scripts/near-lite.mjs'

// the same generator as bots.mjs (module-private there)
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const argv = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : dflt
}
const contract = argv[0]
const NIGHTS = Number(opt('nights', 5))
const SMOKE = new Set(String(opt('smoke', '')).split(',').filter(Boolean).map(Number))
const VISITOR = String(opt('visitor', ''))
  .split(',')
  .filter(Boolean)
  .map((s) => {
    const [i, sec, amt] = s.split(':')
    return { i: Number(i), ms: Math.round(Number(sec) * 1000), amount: BigInt(Math.round(Number(amt) * 1e6)) * 10n ** 12n }
  })
const [seedLo, seedHi] = String(opt('seeds', '1-200000')).split('-').map(Number)
const TOP = Number(opt('top', 8))
const SHOW = opt('show', null)
const VISITOR_ID = 'visitor'

const secret = (process.env.BONFIRE_BOTS ?? '').trim()
if (!secret) {
  console.error('set BONFIRE_BOTS as for scripts/bots.mjs (only the bot order and labels are used)')
  process.exit(64)
}
const bots = botsFromSecret(secret, contract).map((b) => ({ account: b.account, label: b.label }))
const { config: cfg, genesis_ms: genesisMs } = await view(contract, 'config')
const st = await view(contract, 'state')
const nightMs = Number(cfg.night_ms)
const params = readJson(join(ROOT, 'sim', 'params.json')).testnet
const sizes = Object.fromEntries(params.demo_bots.map((d) => [d.label, BigInt(d.throw)]))
const balances = Object.fromEntries(await Promise.all(bots.map(async (b) => [b.account, BigInt((await view(contract, 'holder', { account_id: b.account })).balance)])))

// where the run starts and the fire it starts with
let start = opt('start', null) === null ? null : Number(opt('start'))
const clock = Math.floor((st.now_ms - genesisMs) / nightMs) + 1
if (start === null) start = st.now_ms - (genesisMs + (clock - 1) * nightMs) > 0.15 * nightMs ? clock + 1 : clock
let target0 = opt('target', null) === null ? null : (BigInt(Math.round(Number(opt('target')) * 1e6)) * 10n ** 12n)
let streak0 = opt('streak', null) === null ? null : Number(opt('streak'))
if (target0 === null || streak0 === null) {
  // the open night settles before the run: lit if its pile already reached the target
  const pile = BigInt(st.pile)
  const target = BigInt(st.target)
  const lit = st.night < start && pile > 0n && pile >= target
  const cold = st.night < start && !lit
  const grown = lit ? (target * (10_000n + BigInt(cfg.grow_bp))) / 10_000n : cold && st.night < clock ? target : (target * (10_000n - BigInt(cfg.shrink_bp))) / 10_000n
  if (target0 === null) target0 = st.night < start ? (grown < BigInt(cfg.target_min) ? BigInt(cfg.target_min) : grown) : target
  if (streak0 === null) streak0 = lit ? st.streak + 1 : st.night < start ? 0 : st.streak
}

function simulate(seed, trace = false) {
  const rngs = bots.map((_, i) => mulberry32(seed * 7919 + i * 104729 + 1))
  const m = {
    night: start, target: target0, pile: 0n, windows: Array(cfg.pool_windows).fill(0n), hearth: BigInt(st.hearth), supply: BigInt(st.supply),
    streak: streak0, records: { total_minted: 0n, total_burned: 0n, nights_lit: 0, nights_smoked: 0, nights_cold: 0, longest_streak: 0, tallest_fire: 0n },
    throwers: new Map(), firestarter: null, lastLog: null, owed: 0n, owedNights: 0,
  }
  const bal = { ...balances }
  const nights = []
  for (let i = 1; i <= NIGHTS; i++) {
    const smoke = SMOKE.has(i)
    const events = []
    bots.forEach((b, idx) => {
      const beh = BEHAVIOURS[b.label]
      const plan = planNight(beh, rngs[idx], true)
      if (!plan) return
      if (smoke && beh.logic !== 'plain') return
      const at = Math.min(Math.floor(plan.t * nightMs), nightMs - 12_000)
      events.push({ who: b.label, account: b.account, at, beh, fBp: smoke ? plan.fBp / 4n : plan.fBp, bot: true })
    })
    for (const v of VISITOR.filter((x) => x.i === i)) events.push({ who: VISITOR_ID, account: VISITOR_ID, at: v.ms, amount: v.amount })
    // the bots settle and collect first (about 12 s), so an earlier plan lands then
    for (const e of events) e.eff = e.bot ? Math.max(e.at, 12_000) : e.at
    events.sort((a, b) => a.eff - b.eff)
    const log = []
    const target = m.target
    const visitorWood = {}
    for (const e of events) {
      let amount = e.amount
      if (e.bot) {
        const live = { pile: m.pile.toString(), target: m.target.toString(), streak: m.streak }
        amount = decide(e.beh, sizes[e.who], e.fBp, live, bal[e.account], cfg)
        if (amount === 0n) {
          log.push({ who: e.who, at: e.eff, amount: 0n, pile: m.pile })
          continue
        }
        bal[e.account] -= amount
      }
      const w = windowAt(cfg, 0, e.eff)
      const before = m.pile
      m.windows[w] += amount
      m.pile += amount
      m.throwers.set(e.account, (m.throwers.get(e.account) ?? 0n) + amount)
      if (!m.firestarter) m.firestarter = e.who
      if (!m.lastLog && before < target && m.pile >= target) m.lastLog = e.who
      if (e.who === VISITOR_ID) visitorWood[w] = (visitorWood[w] ?? 0n) + amount
      log.push({ who: e.who, at: e.eff, window: w, amount, pile: m.pile })
    }
    const w0 = m.windows[0]
    const rec = settleNight(m, cfg)
    const visitor = Object.keys(visitorWood).length ? creditOf(rec, visitorWood) : null
    nights.push({ i, night: rec.night, smoke, target, outcome: rec.outcome, pile: rec.pile, w0, firestarter: rec.firestarter, lastLog: rec.last_log, streak: rec.streak, log, visitor, visitorWood, next: rec.target_next })
  }
  return nights
}

function score(nights) {
  let s = 0
  const a = nights[0]
  if (a.outcome !== 'LIT') return -1e9
  if (a.firestarter !== VISITOR_ID) return -1e9
  const firstBot = a.log.find((e) => e.who !== VISITOR_ID && e.amount > 0n)
  const vis = a.log.find((e) => e.who === VISITOR_ID)
  if (!firstBot || !vis) return -1e9
  s += Math.min(30, (firstBot.at - vis.at) / 1000) // seconds the visitor's log is alone on the pile
  const w0 = Number((a.w0 * 1000n) / a.target) / 1000
  if (w0 >= 1) return -1e9
  s += w0 >= 0.6 && w0 <= 0.9 ? 20 : 0
  if (a.lastLog === 'demo-bot-late') s += 40
  else if (a.lastLog === 'demo-bot-steady') s += 20
  for (const n of nights.slice(1)) {
    if (n.smoke && n.outcome !== 'SMOKED') return -1e9
    if (!n.smoke && n.outcome !== 'LIT') return -1e9
  }
  return s
}

const fmtS = (ms) => `${(ms / 1000).toFixed(0).padStart(3)} s`
function show(seed) {
  const nights = simulate(seed, true)
  console.log(`seed ${seed}: run from night ${start}, target ${ember(target0)}, streak ${streak0}, score ${score(nights).toFixed(1)}`)
  for (const n of nights) {
    console.log(`  run night ${n.i} = night ${n.night}${n.smoke ? ' (smoke)' : ''}: target ${ember(n.target)}, pile ${ember(n.pile)} -> ${n.outcome}; firestarter ${n.firestarter}, last log ${n.lastLog ?? '-'}; streak ${n.streak}; next target ${ember(n.next)}`)
    for (const e of n.log) console.log(`      ${fmtS(e.at)}  w${e.window ?? '-'}  ${e.who.padEnd(17)} ${e.amount > 0n ? ember(e.amount).padStart(9) : '  holds back'}  pile ${ember(e.pile)}`)
    if (n.visitor) {
      const wood = Object.values(n.visitorWood).reduce((a, b) => a + b, 0n)
      console.log(`      visitor: ${ember(wood)} wood -> credit ${ember(n.visitor.amount)} (${n.visitor.amount >= wood ? '+' : '-'}${ember(n.visitor.amount >= wood ? n.visitor.amount - wood : wood - n.visitor.amount)})`)
    }
  }
}

if (SHOW !== null) show(Number(SHOW))
else {
  const best = []
  for (let seed = seedLo; seed <= seedHi; seed++) {
    const sc = score(simulate(seed))
    if (sc <= -1e8) continue
    best.push([sc, seed])
    best.sort((a, b) => b[0] - a[0])
    if (best.length > TOP) best.pop()
  }
  console.log(`run from night ${start} (${new Date(genesisMs + (start - 1) * nightMs).toISOString()}), target ${ember(target0)}, streak ${streak0}; ${best.length} seeds kept of ${seedHi - seedLo + 1}`)
  for (const [, seed] of best) show(seed)
}
void EMBER
