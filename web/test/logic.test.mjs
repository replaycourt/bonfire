import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as L from '../js/logic.js'

const D = 18
const E = (n) => L.toUnits(n, D)

test('units: whole EMBER to base units and back', () => {
  assert.equal(L.toUnits('1', 18), 10n ** 18n)
  assert.equal(L.toUnits('2.5', 18), 25n * 10n ** 17n)
  assert.equal(L.toUnits(4000, 0), 4000n)
  assert.equal(L.toWhole(25n * 10n ** 17n, 18), 2.5)
})

test('fmtEmber: grouping, decimals, dust, compact, sign', () => {
  assert.equal(L.fmtEmber(E(1234567), D), '1,234,567')
  assert.equal(L.fmtEmber(E('87.35'), D), '87.35')
  assert.equal(L.fmtEmber(E('87.30'), D), '87.3')
  assert.equal(L.fmtEmber(E('87'), D), '87')
  assert.equal(L.fmtEmber(E('0.004'), D), '0.004')
  assert.equal(L.fmtEmber(0n, D), '0')
  assert.equal(L.fmtEmber(E(1_002_340), D, { compact: true }), '1M')
  assert.equal(L.fmtEmber(E(12_340), D, { compact: true }), '12.3k')
  assert.equal(L.fmtEmber(E(5), D, { sign: true }), '+5')
  assert.equal(L.fmtEmber(-E(5), D), '-5')
  assert.equal(L.fmtEmber(1500n, 0), '1,500')
})

test('countdown, duration, percent and factor texts', () => {
  assert.equal(L.fmtCountdown(299_001), '5:00')
  assert.equal(L.fmtCountdown(61_000), '1:01')
  assert.equal(L.fmtCountdown(0), '0:00')
  assert.equal(L.fmtCountdown(-5), '0:00')
  assert.equal(L.fmtCountdown(3_723_000), '1:02:03')
  assert.equal(L.fmtCountdown(2 * 86_400_000 + 3 * 3_600_000), '2d 03h')
  assert.equal(L.fmtDuration(300_000), '5 minutes')
  assert.equal(L.fmtDuration(86_400_000), '1 day')
  assert.equal(L.fmtDuration(90_000), '90 seconds')
  assert.equal(L.fmtPct(700), '7 %')
  assert.equal(L.fmtPct(25), '0.25 %')
  assert.equal(L.fmtPct(10), '0.1 %')
  assert.equal(L.fmtFactor(60_000), '×6')
  assert.equal(L.fmtFactor(45_250), '×4.5')
  assert.equal(L.fmtFactor(1000), '×0.1')
})

test('clock night follows genesis and night length', () => {
  assert.equal(L.clockNight(1000, 1000, 300_000), 1)
  assert.equal(L.clockNight(1000 + 299_999, 1000, 300_000), 1)
  assert.equal(L.clockNight(1000 + 300_000, 1000, 300_000), 2)
  assert.equal(L.clockNight(0, 1000, 300_000), 1)
})

test('early factor falls linearly from early_max to 1.0 and rounds up for the thrower', () => {
  assert.equal(L.earlyBp(0, 300_000, 60_000), 60_000)
  assert.equal(L.earlyBp(150_000, 300_000, 60_000), 35_000)
  assert.equal(L.earlyBp(300_000, 300_000, 60_000), 10_000)
  assert.equal(L.earlyBp(999_999, 300_000, 60_000), 10_000)
  // 50000 * 1 / 300000 = 0.166..: the decrement rounds down, so the factor stays 60000
  assert.equal(L.earlyBp(1, 300_000, 60_000), 60_000)
  assert.equal(L.earlyBp(7, 300_000, 60_000), 59_999)
})

test('throw weight: early below the target, late above it, split when crossing', () => {
  // all below
  assert.equal(L.throwWeight({ amount: 100n, pile: 0n, target: 1000n, earlyBp: 20_000, lateLitBp: 1000 }), 100n * 20_000n)
  // crossing: 50 below, 50 above
  assert.equal(L.throwWeight({ amount: 100n, pile: 950n, target: 1000n, earlyBp: 20_000, lateLitBp: 1000 }), 50n * 20_000n + 50n * 1000n)
  // all above
  assert.equal(L.throwWeight({ amount: 100n, pile: 1200n, target: 1000n, earlyBp: 20_000, lateLitBp: 1000 }), 100n * 1000n)
})

test('lit pool: mint share of the target, hearth cut, capped at the supply cap', () => {
  const p = L.lightPool({ target: E(4000), mintBp: 500, hearthCutBp: 2000 })
  assert.equal(p.mint, E(200))
  assert.equal(p.cut, E(40))
  assert.equal(p.pool, E(160))
  const capped = L.lightPool({ target: 1000n, mintBp: 500, hearthCutBp: 2000, supply: 990n, supplyCap: 1000n })
  assert.equal(capped.mint, 10n)
  assert.equal(capped.cut, 2n)
})

test('expected reward is the weight share of the pool, rounded down', () => {
  assert.equal(L.expectedReward({ pool: 160n, myWeight: 1n, totalWeight: 3n }), 53n)
  assert.equal(L.expectedReward({ pool: 160n, myWeight: 0n, totalWeight: 3n }), 0n)
  assert.equal(L.expectedReward({ pool: 160n, myWeight: 5n, totalWeight: 0n }), 0n)
})

test('smoke loss is the burned share of the thrower wood, as the contract rounds it', () => {
  // pile 1000, 1 % burns -> 990 back pro rata; a thrower of 333 gets 329 back (329.67 rounded down)
  assert.equal(L.smokeLoss({ wood: 333n, pile: 1000n, smokeBp: 100 }), 4n)
  assert.equal(L.smokeLoss({ wood: 0n, pile: 1000n, smokeBp: 100 }), 0n)
})

test('signing text and action JSON match the contract format', () => {
  assert.equal(L.signingText('bonfire-coin.testnet', 7, '{"claim_kindling":{"night":12}}'), 'bonfire:v1:bonfire-coin.testnet:7:{"claim_kindling":{"night":12}}')
  assert.equal(L.throwAction(5_000_000_000_000_000_000_000n, 12), '{"throw":{"amount":"5000000000000000000000","night":12}}')
  assert.equal(L.kindlingAction(12), '{"claim_kindling":{"night":12}}')
})

test('nonces rise, follow the clock, and stay JS-safe', () => {
  assert.equal(L.nextNonce(0, 1_700_000_000_000), 1_700_000_000_000)
  assert.equal(L.nextNonce(1_800_000_000_000, 1_700_000_000_000), 1_800_000_000_001)
  assert.throws(() => L.nextNonce(Number.MAX_SAFE_INTEGER, 0))
})

test('throw choices: round amounts below the balance, plus All', () => {
  const c = L.throwChoices(E(2000), D, E(1))
  assert.deepEqual(c.map((x) => x.label), ['250', '500', '1,000', 'All'])
  assert.equal(c[3].amount, E(2000))
  assert.deepEqual(L.throwChoices(E(150), D, E(1)).map((x) => x.label), ['10', '25', '50', 'All'])
  assert.deepEqual(L.throwChoices(E(3), D, E(1)).map((x) => x.label), ['1', 'All'])
  assert.deepEqual(L.throwChoices(E(4230), D, E(1)).map((x) => x.label), ['500', '1,000', '2,000', 'All'])
  assert.deepEqual(L.throwChoices(0n, D, E(1)), [])
  assert.deepEqual(L.throwChoices(E('0.5'), D, E(1)), [])
})

const cfg = {
  config: { symbol: 'EMBER', decimals: D, night_ms: 300_000, early_max_bp: 60_000, late_lit_bp: 1000, mint_bp: 500, hearth_cut_bp: 2000, smoke_bp: 100, min_throw: E(1).toString(), kindling: E(2000).toString(), kindling_per_night: 5 },
  genesis_ms: 1_000_000,
  supply_cap: (1n << 112n).toString(),
}

function state(over = {}) {
  return {
    night: 3,
    night_start_ms: 1_600_000,
    night_end_ms: 1_900_000,
    now_ms: 1_700_000,
    due: false,
    nights_due: 0,
    clock_night: 3,
    target: E(4000).toString(),
    pile: E(1000).toString(),
    throwers: 2,
    max_throwers: 88,
    weight: (E(1000) * 50_000n).toString(),
    reached: false,
    early_bp_now: 43_334,
    streak: 2,
    records: { longest_streak: 2 },
    hearth: E(390_000).toString(),
    supply: E(1_000_100).toString(),
    kindling_left_tonight: 4,
    accounts_sponsored: 30,
    max_accounts: 1000,
    last: { night: 2, outcome: 'lit', target: E(3700).toString(), pile: E(3900).toString() },
    ...over,
  }
}

const holder = (over = {}) => ({ registered: true, balance: E(2000).toString(), wood: '0', weight: '0', nonce: 3, sponsored: true, held: true, kindled: true, may_take_kindling: false, ...over })

test('model: progress, gap, phase and the early factor from the views', () => {
  const m = L.deriveModel({ cfg, state: state(), holder: holder(), tonight: null, nowMs: 1_750_000 })
  assert.equal(m.night, 3)
  assert.equal(m.msLeft, 150_000)
  assert.equal(m.progress, 0.5)
  assert.equal(m.pct, 0.25)
  assert.equal(m.gap, E(3000))
  assert.equal(m.phase, 'building')
  assert.equal(m.earlyBp, 35_000)
  assert.equal(m.canThrow, true)
  assert.deepEqual(m.choices.map((c) => c.label), ['250', '500', '1,000', 'All'])
  assert.equal(m.kindle.can, false)
  assert.equal(m.kindle.why, 'claimed')
})

test('model: phases empty, close, reached and due', () => {
  const at = (s, now = 1_750_000) => L.deriveModel({ cfg, state: state(s), holder: holder(), tonight: null, nowMs: now }).phase
  assert.equal(at({ pile: '0', weight: '0', throwers: 0 }), 'empty')
  assert.equal(at({ pile: E(3100).toString() }), 'close')
  assert.equal(at({ pile: E(4000).toString() }), 'reached')
  assert.equal(at({}, 1_900_000), 'due')
  assert.equal(at({ due: true, nights_due: 1 }), 'due')
})

test('model: expected reward and smoke loss for the player wood', () => {
  const w = E(500) * 50_000n
  const m = L.deriveModel({ cfg, state: state({ pile: E(1500).toString(), weight: (E(1000) * 50_000n + w).toString() }), holder: holder({ wood: E(500).toString(), weight: w.toString() }), tonight: null, nowMs: 1_750_000 })
  // pool 160 EMBER, my weight is a third of the total
  assert.equal(m.reward, E(160) / 3n)
  assert.equal(m.iThrew, true)
  assert.equal(m.loss, E(500) - ((E(1500) - E(15)) * E(500)) / E(1500))
})

test('model: throw preview grows the share and adds early weight', () => {
  const m = L.deriveModel({ cfg, state: state(), holder: holder(), tonight: null, nowMs: 1_750_000 })
  const p = L.throwPreview(m, E(500))
  assert.equal(p.weight, E(500) * 35_000n)
  const expected = (E(160) * p.weight) / (E(1000) * 50_000n + p.weight)
  assert.equal(p.reward, expected)
  assert.equal(p.gain, expected)
})

test('model: kindling availability and its reasons', () => {
  const fresh = { registered: false, balance: '0', wood: '0', weight: '0', nonce: 0, may_take_kindling: true, held: false, kindled: false }
  const k = (s, h = fresh) => L.deriveModel({ cfg, state: state(s), holder: h, tonight: null, nowMs: 1_750_000 }).kindle
  assert.deepEqual(k({}), { can: true, why: '' })
  assert.equal(k({ kindling_left_tonight: 0 }).why, 'gone')
  assert.equal(k({ hearth: E(100).toString() }).why, 'dry')
  assert.equal(k({ accounts_sponsored: 1000 }).why, 'full')
  const m = L.deriveModel({ cfg, state: state(), holder: fresh, tonight: null, nowMs: 1_750_000 })
  assert.equal(m.canThrow, false)
  assert.deepEqual(m.choices, [])
})

test('model: no throws once dawn has come, and no seat when the fire is full', () => {
  const due = L.deriveModel({ cfg, state: state(), holder: holder(), tonight: null, nowMs: 1_900_001 })
  assert.equal(due.canThrow, false)
  const full = L.deriveModel({ cfg, state: state({ throwers: 88 }), holder: holder(), tonight: null, nowMs: 1_750_000 })
  assert.equal(full.canThrow, false)
  const seated = L.deriveModel({ cfg, state: state({ throwers: 88 }), holder: holder({ wood: E(10).toString(), weight: '1' }), tonight: null, nowMs: 1_750_000 })
  assert.equal(seated.canThrow, true)
})

test('headline says what tonight needs', () => {
  const m = (s, now = 1_750_000) => L.headline(L.deriveModel({ cfg, state: state(s), holder: holder(), tonight: null, nowMs: now }))
  assert.equal(m({}).big, '3,000 EMBER')
  assert.equal(m({ pile: '0' }).big, '4,000 EMBER')
  assert.equal(m({ pile: E(4100).toString() }).big, 'Enough wood')
  assert.equal(m({}, 1_950_000).big, 'Dawn')
})

test('history: strip of the last nights and the supply series', () => {
  const rows = [1, 2, 3, 4].map((n) => ({ night: n, target: E(1000).toString(), pile: E(n * 400).toString(), outcome: n * 400 >= 1000 ? 'lit' : 'smoke', minted: '0', burned: '0', supply: E(1_000_000 + n).toString() }))
  const s = L.nightStrip(rows, 3)
  assert.deepEqual(s.map((r) => r.night), [2, 3, 4])
  assert.equal(s[0].pct, 0.8)
  assert.equal(s[2].outcome, 'lit')
  const series = L.supplySeries(rows, D)
  assert.equal(series[3].supply, 1_000_004)
  assert.equal(L.historyFrom(42, 24), 18)
  assert.equal(L.historyFrom(5, 24), 1)
})

test('night result turns the player line into words', () => {
  const nv = {
    night: 9,
    outcome: 'lit',
    target: E(4000).toString(),
    pile: E(4600).toString(),
    minted: E(200).toString(),
    hearth_cut: E(40).toString(),
    burned: '0',
    throwers: [{ account: 'me', wood: E(500).toString(), weight: '1', back: E(500).toString(), reward: E('21.5').toString(), lost: '0' }],
  }
  const r = L.nightResult(nv, 'me', D, 'EMBER')
  assert.equal(r.title, 'Night 9 caught fire')
  assert.equal(r.text, 'Your 500 wood came back, plus 21.5 new EMBER.')
  const smoke = L.nightResult({ ...nv, outcome: 'smoke', burned: E(30).toString(), throwers: [{ account: 'me', wood: E(500).toString(), back: E(495).toString(), reward: '0', lost: E(5).toString() }] }, 'me', D, 'EMBER')
  assert.equal(smoke.text, '495 of your 500 wood came back; 5 burned.')
  const other = L.nightResult({ ...nv, outcome: 'smoke', burned: E(30).toString() }, 'you', D, 'EMBER')
  assert.equal(other.text, '4,600 of 4,000 wood was not enough. 30 EMBER burned.')
  assert.equal(L.nightResult({ ...nv, outcome: 'empty', throwers: [] }, 'me', D, 'EMBER').title, 'Night 9 stayed cold')
  assert.equal(L.nightResult(nv, 'you', D, 'EMBER').text, '1 thrower shared 160 new EMBER.')
})

test('seats: the player first, then the biggest wood, capped', () => {
  const t = [
    { account: 'a', wood: '5' },
    { account: 'me', wood: '1' },
    { account: 'b', wood: '9' },
  ]
  const s = L.seats(t, 'me', 2)
  assert.deepEqual(s.shown.map((x) => x.account), ['me', 'b'])
  assert.equal(s.more, 1)
  assert.equal(L.hashSeed('abc'), L.hashSeed('abc'))
  assert.notEqual(L.hashSeed('abc'), L.hashSeed('abd'))
})

test('only SVG data URLs pass as the coin icon', () => {
  assert.ok(L.safeIcon("data:image/svg+xml,%3Csvg%3E"))
  assert.equal(L.safeIcon('javascript:alert(1)'), null)
  assert.equal(L.safeIcon('https://example.com/x.svg'), null)
  assert.equal(L.safeIcon(null), null)
})
