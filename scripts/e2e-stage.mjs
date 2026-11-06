#!/usr/bin/env node
// Scripted end-to-end run on a staging contract: the five demo bots play a fixed plan (two lit
// nights, a deliberate smoky night, a cold night, a lit night, a quiet night that forces a
// catch-up, two more lit nights), and a fresh visitor plays as a browser would: a new ed25519 key
// claims kindling through `act`, throws, and collects after the night. After every transaction
// the run compares the chain with an independent model of the rules (scripts/bonfire-lib.mjs):
// audit(), every balance and holder record, state(), recent_throws(), and after every settle the
// night logs, history() and the live ft_metadata().icon.
//
//   node scripts/e2e-stage.mjs <contract> --out <dir> [--nights 8] [--seed 1]
//
// <dir> receives e2e-results.json (every step, check and gas figure) and the icons as SVG files.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tgas, view } from './near-lite.mjs'
import { Runner } from './bots.mjs'
import {
  EMBER, Player, ROOT, Relay, creditOf, ember, loadBots, parseEvents, readJson, settleNight, sleep,
  windowAt, windowWeights, writeSecret,
} from './bonfire-lib.mjs'

const argv = process.argv.slice(2)
const opt = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const contract = argv[0]
const out = opt('--out')
const NIGHTS = Number(opt('--nights') ?? 8)
if (!contract || contract.startsWith('--') || !out || !(NIGHTS >= 7 && NIGHTS <= 12)) {
  console.error('usage: e2e-stage.mjs <contract> --out <dir> [--nights 7-12] [--seed 1]')
  process.exit(64)
}
mkdirSync(out, { recursive: true })
const PLAN = { smoke: new Set([3]), cold: new Set([4]), quiet: new Set([6]) }

const relay = new Relay(contract)
const bots = loadBots(contract)
const visitor = Player.fresh('visitor')
writeSecret(`visitor-${contract}-${visitor.account.slice(0, 8)}.json`, { label: 'visitor', account_id: visitor.account, secret_key: visitor.secretKey })
const players = [...bots, visitor]
const label = Object.fromEntries(players.map((p) => [p.account, p.label]))
const { config: cfg, genesis_ms: genesisMs, founders, genesis_supply: genesisSupply } = await view(contract, 'config')
const params = readJson(join(ROOT, 'sim', 'params.json')).testnet
const sizes = Object.fromEntries(params.demo_bots.map((d) => [d.label, BigInt(d.throw)]))

// ---- a clean start: settle what is due, collect what is owed ----------------------------------------
// The run can follow an earlier one on the same contract: it first settles the ended nights and
// collects for every player, so the model starts from a pile of zero with nothing owed.

const prepTx = []
async function prepCall(method, args, what) {
  const r = await relay.call(method, args, { slot: 7 })
  prepTx.push({ label: what, kind: `prep-${method}`, hash: r.hash, gas: r.gas, txGas: r.txGas, contractGas: r.contractGas, failure: r.failure, value: r.value })
  console.log(`prep: ${what.padEnd(46)} ${tgas(r.gas).padStart(6)} Tgas  ${r.hash}${r.failure ? '  FAILED ' + r.failure : ''}`)
}
{
  let st = await view(contract, 'state')
  if (BigInt(st.pile) > 0n) {
    console.log(`prep: the open night ${st.night} has wood; waiting for it to end`)
    await sleep(Math.max(0, st.night_end_ms - st.now_ms) + 4000)
    st = await view(contract, 'state')
  }
  for (let i = 0; i < 5 && st.nights_due > 0; i++) {
    await prepCall('settle', {}, `settle ${st.nights_due} ended nights`)
    await sleep(1500)
    st = await view(contract, 'state')
  }
  // Our players, and whoever threw lately (a visitor key of an earlier run).
  const recentAccounts = (await view(contract, 'recent_throws')).map((r) => r.account)
  const known = Object.fromEntries(players.map((p) => [p.account, p.label]))
  for (const a of new Set([...players.map((p) => p.account), ...recentAccounts])) {
    const h = await view(contract, 'holder', { account_id: a })
    if (BigInt(h.pending) > 0n) await prepCall('collect', { account_id: a }, `collect(${known[a] ?? a.slice(0, 8) + '...'})`)
  }
  for (let i = 0; i < 15 && BigInt((await view(contract, 'state')).owed) > 0n; i++) await sleep(1500)
}

// ---- the model -----------------------------------------------------------------------------------

let genesisProblems = []

// The model starts from the chain: on a fresh contract that is the genesis (checked below), on a
// contract that already ran it is the state after a clean end (no wood on the pile, nothing owed).
const st0 = await view(contract, 'state')
if (BigInt(st0.pile) !== 0n || BigInt(st0.owed) !== 0n) {
  console.error(`cannot start: the open night has wood (${st0.pile}) or settled nights are owed (${st0.owed})`)
  process.exit(65)
}
const m = {
  night: st0.night, target: BigInt(st0.target), pile: 0n, windows: Array(cfg.pool_windows).fill(0n), throwers: new Map(),
  firestarter: null, lastLog: null, hearth: BigInt(st0.hearth), supply: BigInt(st0.supply), streak: st0.streak,
  owed: 0n, owedNights: 0, sponsored: st0.accounts_sponsored, recent: [],
  records: Object.fromEntries(Object.entries(st0.records).map(([k, v]) => [k, typeof v === 'string' ? BigInt(v) : v])),
}
const r0 = await view(contract, 'recent_throws')
m.recent = r0.map((r) => ({ night: r.night, window: r.window, account: r.account, amount: BigInt(r.amount), pile: BigInt(r.pile) }))
const prior = (await view(contract, 'history', { from: 1, limit: 500 })).map((h) => h.outcome)
const h0 = await Promise.all(players.map((p) => view(contract, 'holder', { account_id: p.account })))
const acct = new Map(players.map((p, i) => [p.account, { credited: BigInt(h0[i].credited), woodNight: null, wood: {}, registered: h0[i].registered }]))
const fresh = st0.night === 1
if (fresh) {
  const p = []
  if (m.hearth !== BigInt(cfg.hearth_genesis)) p.push(`hearth ${m.hearth} is not hearth_genesis`)
  if (m.supply !== BigInt(genesisSupply)) p.push(`supply ${m.supply} is not the genesis supply`)
  for (const f of founders) if (acct.get(f.account_id)?.credited !== BigInt(f.amount)) p.push(`founder ${f.account_id} does not hold its allocation`)
  if (founders.length !== bots.length || founders.some((f, i) => f.account_id !== bots[i].account)) p.push('founders are not the demo bots')
  genesisProblems = p
}
const nights = new Map() // night -> settled record
const firstModelNight = st0.night
const dust = []

function pendingOf(a) {
  const x = acct.get(a)
  if (x.woodNight === null || x.woodNight >= m.night) return { amount: 0n, weight: 0n }
  return creditOf(nights.get(x.woodNight), x.wood)
}

function openWeight(a) {
  const x = acct.get(a)
  if (x.woodNight === null) return 0n
  const ws = x.woodNight === m.night ? windowWeights(m.windows, m.target, BigInt(cfg.early_max_bp), BigInt(cfg.late_lit_bp)) : null
  if (!ws) return pendingOf(a).weight
  let w = 0n
  for (const [win, amt] of Object.entries(x.wood)) w += (ws[win][1] * amt) / ws[win][0]
  return w
}

function collect(a) {
  const x = acct.get(a)
  if (x.woodNight === null || x.woodNight >= m.night) return { night: null, amount: 0n }
  const rec = nights.get(x.woodNight)
  const { amount } = creditOf(rec, x.wood)
  const night = x.woodNight
  x.credited += amount
  x.woodNight = null
  x.wood = {}
  m.owed -= amount
  rec.remaining -= amount
  rec.left -= 1
  if (rec.left === 0) {
    dust.push({ night, dust: rec.remaining })
    m.hearth += rec.remaining
    m.owed -= rec.remaining
    rec.remaining = 0n
    m.owedNights -= 1
  }
  return { night, amount }
}

function throwWood(a, amount, window) {
  const x = acct.get(a)
  const before = m.pile
  x.credited -= amount
  if (x.woodNight === null) {
    x.woodNight = m.night
    m.throwers.set(a, x.wood)
  }
  x.wood[window] = (x.wood[window] ?? 0n) + amount
  m.pile += amount
  m.windows[window] += amount
  const firestarter = m.firestarter === null
  if (firestarter) m.firestarter = a
  const crossed = before < m.target && m.pile >= m.target
  if (crossed) m.lastLog = { account: a, amount }
  m.recent.push({ night: m.night, window, account: a, amount, pile: m.pile })
  if (m.recent.length > 16) m.recent.shift()
  return { firestarter, crossed }
}

// ---- checks --------------------------------------------------------------------------------------

const checks = []
let failures = 0
const eq = (p, what, got, want) => {
  if (String(got) !== String(want)) p.push(`${what}: chain ${got}, expected ${want}`)
}

function record(stepLabel, kind, problems) {
  checks.push({ step: stepLabel, kind, ok: problems.length === 0, problems })
  if (problems.length) {
    failures++
    console.log(`  CHECK FAILED (${kind}) after ${stepLabel}:\n    ${problems.join('\n    ')}`)
  }
}

async function compareAll() {
  const p = []
  const [audit, st, recent, ...rest] = await Promise.all([
    view(contract, 'audit'),
    view(contract, 'state'),
    view(contract, 'recent_throws'),
    ...players.map((x) => view(contract, 'holder', { account_id: x.account })),
    ...players.map((x) => view(contract, 'ft_balance_of', { account_id: x.account })),
  ])
  const holders = rest.slice(0, players.length)
  const balances = rest.slice(players.length)
  if (!audit.balanced) p.push('audit: not balanced')
  if (!audit.ledger) p.push('audit: ledger broken')
  eq(p, 'audit.supply', audit.supply, m.supply)
  eq(p, 'audit.hearth', audit.hearth, m.hearth)
  eq(p, 'audit.pile', audit.pile, m.pile)
  eq(p, 'audit.owed', audit.owed, m.owed)
  eq(p, 'state.night', st.night, m.night)
  eq(p, 'state.target', st.target, m.target)
  eq(p, 'state.pile', st.pile, m.pile)
  eq(p, 'state.throwers', st.throwers, m.throwers.size)
  eq(p, 'state.streak', st.streak, m.streak)
  eq(p, 'state.firestarter', st.firestarter, m.firestarter)
  eq(p, 'state.last_log', st.last_log ? `${st.last_log.account}:${st.last_log.amount}` : null, m.lastLog ? `${m.lastLog.account}:${m.lastLog.amount}` : null)
  eq(p, 'state.owed_nights', st.owed_nights, m.owedNights)
  eq(p, 'state.accounts_sponsored', st.accounts_sponsored, m.sponsored)
  eq(p, 'state.windows', st.windows.map((w) => w.wood).join(','), m.windows.join(','))
  for (const [k, v] of Object.entries(m.records)) eq(p, `records.${k}`, st.records[k], v)
  players.forEach((x, i) => {
    const h = holders[i]
    const a = acct.get(x.account)
    const pend = pendingOf(x.account).amount
    const total = Object.values(a.wood).reduce((s, v) => s + v, 0n)
    eq(p, `${x.label} ft_balance_of`, balances[i], a.credited + pend)
    eq(p, `${x.label} holder.balance`, h.balance, a.credited + pend)
    eq(p, `${x.label} holder.credited`, h.credited, a.credited)
    eq(p, `${x.label} holder.pending`, h.pending, pend)
    eq(p, `${x.label} holder.registered`, h.registered, a.registered)
    eq(p, `${x.label} holder.wood_night`, h.wood_night, a.woodNight)
    eq(p, `${x.label} holder.wood`, h.wood, total)
    eq(p, `${x.label} holder.weight`, h.weight, openWeight(x.account))
  })
  const want = m.recent.map((r) => `${r.night}/${r.window}/${r.account.slice(0, 8)}/${r.amount}/${r.pile}`).join(' ')
  const got = recent.map((r) => `${r.night}/${r.window}/${r.account.slice(0, 8)}/${r.amount}/${r.pile}`).join(' ')
  eq(p, 'recent_throws', got, want)
  return { p, audit, st }
}

/** Compares everything; a view right after a transaction can lag, so a mismatch is retried. */
async function checkAll(stepLabel) {
  let res
  for (let attempt = 0; attempt < 6; attempt++) {
    res = await compareAll()
    if (!res.p.length) break
    await sleep(1500)
  }
  record(stepLabel, 'state', res.p)
  return res
}

async function checkNights(stepLabel, list) {
  const p = []
  for (const n of list) {
    const rec = nights.get(n)
    const v = await view(contract, 'night', { n })
    if (!v) {
      p.push(`night(${n}) missing`)
      continue
    }
    for (const k of ['outcome', 'target', 'pile', 'throwers', 'minted', 'hearth_cut', 'burned', 'hearth_burned', 'target_next', 'streak', 'supply', 'firestarter']) {
      eq(p, `night(${n}).${k}`, v[k], rec[k])
    }
    eq(p, `night(${n}).last_log`, v.last_log ? `${v.last_log.account}:${v.last_log.amount}` : null, rec.last_log ? `${rec.last_log.account}:${rec.last_log.amount}` : null)
    const ws = rec.pile > 0n ? windowWeights(rec.windows, rec.target, BigInt(cfg.early_max_bp), BigInt(cfg.late_lit_bp)) : []
    eq(p, `night(${n}).windows`, v.windows.map((w) => `${w.wood}:${w.weight}`).join(','), ws.map(([x, w]) => `${x}:${w}`).join(','))
    eq(p, `night(${n}).owed`, v.owed, rec.remaining)
    eq(p, `night(${n}).uncollected`, v.uncollected, rec.left)
  }
  const hist = await view(contract, 'history', { from: firstModelNight, limit: 100 })
  const want = [...nights.values()].map((r) => [r.night, r.target, r.pile, r.outcome, r.outcome === 'LIT' ? r.minted : 0n, r.outcome === 'LIT' ? 0n : r.burned, r.supply].join('/')).join(' ')
  eq(p, 'history', hist.map((h) => [h.night, h.target, h.pile, h.outcome, h.minted, h.burned, h.supply].join('/')).join(' '), want)
  record(stepLabel, 'nights+history', p)
}

// ---- the icon ------------------------------------------------------------------------------------

const icons = []
let lastIcon = null
async function checkIcon(stepLabel) {
  const meta = await view(contract, 'ft_metadata')
  const svg = decodeURIComponent(meta.icon.replace(/^data:image\/svg\+xml,/, ''))
  const p = []
  const settled = [...nights.values()]
  const last = settled[settled.length - 1]
  const word = !last ? (prior.length ? null : 'FIRST NIGHT') : last.outcome === 'LIT' ? `LIT ×${last.streak}` : last.outcome
  if (word && !svg.includes(`>${word}</text>`)) p.push(`icon word: expected ${word} in ${svg.match(/<text[^>]*>([^<]*)</)?.[1]}`)
  const marks = [
    ...[...svg.matchAll(/<path d='M(\d+) 52C/g)].map((x) => [Number(x[1]), 'LIT']),
    ...[...svg.matchAll(/<circle cx='(\d+)' cy='56' r='2.6'/g)].map((x) => [Number(x[1]), 'SMOKED']),
    ...[...svg.matchAll(/<circle cx='(\d+)' cy='56' r='2' fill='none'/g)].map((x) => [Number(x[1]), 'COLD']),
  ].sort((a, b) => a[0] - b[0]).map((x) => x[1])
  eq(p, 'icon row', marks.join(','), [...prior, ...settled.map((r) => r.outcome)].slice(-7).join(','))
  if (!svg.startsWith('<svg') || !svg.endsWith('</svg>')) p.push('icon: not an SVG document')
  record(stepLabel, 'icon', p)
  if (svg !== lastIcon) {
    lastIcon = svg
    const name = `icon-${String(icons.length + 1).padStart(2, '0')}-${last ? 'night' + last.night + '-' + word.replace(/\s|×/g, '') : 'first-night'}.svg`
    writeFileSync(join(out, name), svg + '\n')
    icons.push({ file: name, word, bytes: meta.icon.length })
  }
}

// ---- applying each transaction to the model --------------------------------------------------------

const gasRows = []
function gasRow(kind, s, note = '') {
  gasRows.push({ kind, note, hash: s.hash, gas: s.gas, txGas: s.txGas, contractGas: s.contractGas })
}

async function onStep(s) {
  const p = []
  const v = s.value
  if (s.failure) {
    if (s.expectFailure && s.failure.includes(s.expectFailure)) {
      gasRow('act failing (replayed nonce)', s)
    } else {
      p.push(`transaction failed: ${s.failure}`)
    }
    record(s.label, 'tx', p)
    await checkAll(s.label)
    return
  }
  const events = parseEvents(s.logs)
  const ended = events.filter((e) => e.standard === 'bonfire' && ['lit', 'smoked', 'cold'].includes(e.event)).flatMap((e) => e.data)
  const settledNow = []
  for (let k = 0; k < ended.length; k++) {
    const rec = settleNight(m, cfg)
    nights.set(rec.night, rec)
    settledNow.push(rec)
  }
  eq(p, 'nights settled in this call', ended.map((e) => e.night).join(','), settledNow.map((r) => r.night).join(','))
  if (v && typeof v.settled === 'number') eq(p, 'value.settled', v.settled, settledNow.length)
  const transfers = events.filter((e) => e.standard === 'nep141' && e.event === 'ft_transfer').flatMap((e) => e.data)
  let collected = { night: null, amount: 0n }
  if (s.kind.startsWith('act')) {
    collected = collect(s.actor)
    eq(p, 'act collected', v.collected, collected.amount)
    if (!v.ok && !s.expectRefusal) p.push(`act refused: ${v.error}`)
    if (s.expectRefusal) {
      if (v.ok) p.push('act should have been refused')
      else if (!v.error.includes(s.expectRefusal)) p.push(`refused with "${v.error}", expected "${s.expectRefusal}"`)
    }
  } else if (s.kind === 'collect') {
    collected = collect(s.actor)
    eq(p, 'collect amount', v.amount, collected.amount)
    eq(p, 'collect night', v.night, collected.night)
  }
  if (collected.amount > 0n) {
    const t = transfers.find((x) => x.memo === `night ${collected.night} collect`)
    eq(p, 'collect ft_transfer event', t?.amount, collected.amount)
  }
  let throwInfo = null
  if (s.kind === 'act-throw' && v.ok) {
    const ev = events.find((e) => e.standard === 'bonfire' && e.event === 'throw')?.data[0]
    if (!ev) p.push('no throw event')
    else {
      const start = genesisMs + (m.night - 1) * Number(cfg.night_ms)
      const lo = windowAt(cfg, start, s.sentMs + runner.offset - 4000)
      const hi = windowAt(cfg, start, s.doneMs + runner.offset + 2000)
      if (ev.window < lo || ev.window > hi) p.push(`throw landed in window ${ev.window}, sent in ${lo}..${hi}`)
      throwInfo = throwWood(s.actor, BigInt(ev.amount), ev.window)
      eq(p, 'throw amount', ev.amount, s.amount)
      eq(p, 'throw event pile', ev.pile, m.pile)
      eq(p, 'throw event target', ev.target, m.target)
      eq(p, 'throw event firestarter', ev.firestarter, throwInfo.firestarter)
      eq(p, 'throw event last_log', ev.last_log, throwInfo.crossed)
      eq(p, 'throw event night', ev.night, m.night)
      s.window = ev.window
    }
  }
  if (s.kind === 'act-kindling' && v.ok) {
    const k = events.find((e) => e.standard === 'bonfire' && e.event === 'kindling')?.data[0]
    const a = acct.get(s.actor)
    if (!a.registered) m.sponsored += 1
    a.registered = true
    a.credited += BigInt(cfg.kindling)
    m.hearth -= BigInt(cfg.kindling)
    m.records.kindling_claims += 1
    eq(p, 'kindling event amount', k?.amount, cfg.kindling)
    eq(p, 'kindling event hearth', k?.hearth, m.hearth)
  }
  record(s.label, 'tx', p)

  // gas rows
  const outcomes = settledNow.map((r) => r.outcome).join('+')
  if (s.kind === 'settle') gasRow(settledNow.length > 1 ? `settle, catch-up of ${settledNow.length} nights` : `settle, 1 night`, s, outcomes)
  else if (s.kind === 'collect') gasRow('collect(account_id)', s, `${collected.night ? nights.get(collected.night).outcome : 'nothing'}${dust.at(-1)?.night === collected.night && collected.night ? ', last thrower' : ''}`)
  else if (s.kind === 'act-kindling') gasRow('act: claim_kindling (new account)', s)
  else if (s.kind === 'act-collect') gasRow('act: collect', s, collected.night ? nights.get(collected.night).outcome : 'nothing')
  else if (s.kind === 'act-refused') gasRow('act: refused action', s, v.error?.slice(0, 40))
  else if (s.kind === 'act-throw') {
    const notes = [throwInfo?.firestarter && 'first of the night', throwInfo?.crossed && 'crossing', collected.amount > 0n && 'collects first', settledNow.length && `settles ${settledNow.length}`].filter(Boolean)
    gasRow('act: throw', s, notes.join(', '))
  }

  await checkAll(s.label)
  if (settledNow.length) {
    await checkNights(s.label, settledNow.map((r) => r.night))
    await checkIcon(s.label)
  }
}

// ---- the visitor's plan --------------------------------------------------------------------------

async function visitorAct(kind, stepLabel, action, opts = {}) {
  const r = await relay.act(visitor, action, { slot: 5, nonce: opts.nonce })
  return runner.step(kind, stepLabel, visitor.account, r, opts)
}

function extra(i, n, run) {
  const at = (f) => genesisMs + (n - 1) * Number(cfg.night_ms) + Math.floor(f * Number(cfg.night_ms))
  const throwAt = (f, amount) => ({
    at: at(f),
    run: async () => visitorAct('act-throw', `night ${n}: visitor throws ${ember(amount)}`, { throw: { amount: String(amount), night: n } }, { amount }),
  })
  const collectNow = { at: 0, run: async () => visitorAct('act-collect', `night ${n}: visitor collects (act)`, { collect: { night: n } }) }
  switch (i) {
    case 1:
      return [
        {
          at: at(0.03),
          run: async () => {
            const before = await view(contract, 'holder', { account_id: visitor.account })
            record('visitor before kindling', 'tx', before.may_take_kindling && !before.registered ? [] : ['visitor should be unknown and may take kindling'])
            return visitorAct('act-kindling', `night ${n}: visitor claims kindling`, { claim_kindling: { night: n } })
          },
        },
        throwAt(0.3, 120n * EMBER),
      ]
    case 2:
      return [
        collectNow,
        {
          at: 0,
          run: async () => {
            // A replayed message: the same signed act again must fail on its nonce.
            const last = runner.steps.at(-1)
            const r = await relay.call('act', last.args, { slot: 5 })
            await runner.step('act-replay', `night ${n}: visitor's collect replayed`, visitor.account, r, { expectFailure: 'nonce already used' })
            await visitorAct('act-refused', `night ${n}: visitor throws for night ${n + 1}`, { throw: { amount: String(EMBER), night: n + 1 } }, { expectRefusal: `the action is for night ${n + 1}` })
            await visitorAct('act-refused', `night ${n}: visitor claims kindling again`, { claim_kindling: { night: n } }, { expectRefusal: 'kindling is only for accounts that never held EMBER' })
          },
        },
        throwAt(0.62, 60n * EMBER),
      ]
    case 3:
      return [throwAt(0.45, 40n * EMBER)] // its throw collects night 2 first
    case 4:
      return [collectNow]
    case 5:
      return [throwAt(0.08, 80n * EMBER)] // window 0, beside the early bots
    case 7:
      return [
        {
          at: 0,
          run: async () => {
            const r = await relay.call('collect', { account_id: visitor.account }, { slot: 7 })
            return runner.step('collect', `night ${n}: collect(visitor) by the relay`, visitor.account, r)
          },
        },
        throwAt(0.85, 50n * EMBER),
      ]
    default:
      if (i === NIGHTS + 1) return [collectNow]
      return []
  }
}

// ---- run -----------------------------------------------------------------------------------------

const runner = new Runner({
  relay, bots, cfg, genesisMs, sizes, seed: Number(opt('--seed') ?? 1), always: true,
  smoke: PLAN.smoke, cold: PLAN.cold, quiet: PLAN.quiet,
  hooks: { step: onStep, extra },
})
console.log(`e2e on ${contract}: ${NIGHTS} nights, smoke ${[...PLAN.smoke]}, cold ${[...PLAN.cold]}, quiet ${[...PLAN.quiet]}; visitor ${visitor.account}`)
record('genesis', 'genesis', genesisProblems)
await checkAll('start')
await checkIcon('start')
let crashed = null
try {
  await runner.run(NIGHTS)
} catch (e) {
  crashed = e.stack || String(e)
  console.log(`RUN STOPPED: ${crashed}`)
}

// ---- the end: everything collected, every outcome seen -----------------------------------------------

const { st, audit } = await checkAll('end')
const endProblems = []
if (m.owed !== 0n || st.owed_nights !== 0) endProblems.push(`something is still owed: ${m.owed} on ${st.owed_nights} nights`)
for (const o of ['LIT', 'SMOKED', 'COLD']) if (![...nights.values()].some((r) => r.outcome === o)) endProblems.push(`no ${o} night`)
if (![...nights.values()].some((r) => r.firestarter)) endProblems.push('no firestarter recorded')
if (![...nights.values()].some((r) => r.last_log)) endProblems.push('no last log recorded')
if (!gasRows.some((g) => /catch-up/.test(g.kind))) endProblems.push('no catch-up settle')
record('end', 'coverage', endProblems)

const byKind = {}
for (const g of gasRows) (byKind[g.kind] ??= []).push(g)
console.log('\nreal gas burnt (whole transaction / contract receipt), Tgas:')
for (const [k, rows] of Object.entries(byKind)) {
  const tot = rows.map((r) => r.gas)
  const rec = rows.map((r) => r.contractGas)
  console.log(`  ${k.padEnd(36)} n=${String(rows.length).padStart(2)}  total ${tgas(Math.min(...tot))}-${tgas(Math.max(...tot))}  receipt ${tgas(Math.min(...rec))}-${tgas(Math.max(...rec))}`)
}
const passed = checks.filter((c) => c.ok).length
console.log(`\nchecks: ${passed} passed, ${checks.length - passed} failed; nights: ${[...nights.values()].map((r) => `${r.night}:${r.outcome}`).join(' ')}`)
console.log(`audit: balanced ${audit.balanced}, ledger ${audit.ledger}, supply ${ember(audit.supply)}, hearth ${ember(audit.hearth)}, storage ${audit.storage_bytes} bytes`)
console.log(`icons: ${icons.map((x) => x.file).join(', ')}`)

const big = (_, x) => (typeof x === 'bigint' ? String(x) : x)
writeFileSync(join(out, 'e2e-results.json'), JSON.stringify({
  contract, visitor: visitor.account, bots: bots.map((b) => ({ label: b.label, account: b.account })), plan: { nights: NIGHTS, smoke: [...PLAN.smoke], cold: [...PLAN.cold], quiet: [...PLAN.quiet] },
  firstNight: runner.firstNight, crashed, prep: prepTx,
  steps: runner.steps.map((s) => ({ label: s.label, kind: s.kind, hash: s.hash, gas: s.gas, txGas: s.txGas, contractGas: s.contractGas, failure: s.failure, value: s.value, window: s.window })),
  gas: gasRows, checks, nights: [...nights.values()].map((r) => ({ ...r, wood: undefined, weights: r.weights.map(([x, w]) => [x, w]) })),
  dust, icons, final: { state: st, audit },
}, big, 2) + '\n')
process.exit(failures || crashed ? 1 : 0)
