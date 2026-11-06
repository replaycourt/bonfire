import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as L from '../js/logic.js'

const D = 18
const E = (n) => L.toUnits(n, D)

// ---- units and texts ------------------------------------------------------------------------------

test('units: whole EMBER to base units and back', () => {
  assert.equal(L.toUnits('1', 18), 10n ** 18n)
  assert.equal(L.toUnits('2.5', 18), 25n * 10n ** 17n)
  assert.equal(L.toUnits(4000, 0), 4000n)
  assert.equal(L.toWhole(25n * 10n ** 17n, 18), 2.5)
})

test('fmtEmber: grouping, decimals, dust, compact, sign; fmtWhole rounds down', () => {
  assert.equal(L.fmtEmber(E(1234567), D), '1,234,567')
  assert.equal(L.fmtEmber(E('87.35'), D), '87.35')
  assert.equal(L.fmtEmber(E('87.30'), D), '87.3')
  assert.equal(L.fmtEmber(E('0.004'), D), '0.004')
  assert.equal(L.fmtEmber(0n, D), '0')
  assert.equal(L.fmtEmber(E(1_002_340), D, { compact: true }), '1M')
  assert.equal(L.fmtEmber(E(12_340), D, { compact: true }), '12.3k')
  assert.equal(L.fmtEmber(E(5), D, { sign: true }), '+5')
  assert.equal(L.fmtEmber(1500n, 0), '1,500')
  assert.equal(L.fmtWhole(E('4999.9'), D), '4,999')
})

test('countdown, duration, percent and factor texts', () => {
  assert.equal(L.fmtCountdown(299_001), '5:00')
  assert.equal(L.fmtCountdown(0), '0:00')
  assert.equal(L.fmtCountdown(3_723_000), '1:02:03')
  assert.equal(L.fmtCountdown(2 * 86_400_000 + 3 * 3_600_000), '2d 03h')
  assert.equal(L.fmtDuration(300_000), '5 minutes')
  assert.equal(L.fmtDuration(86_400_000), '1 day')
  assert.equal(L.fmtPct(700), '7 %')
  assert.equal(L.fmtPct(25), '0.25 %')
  assert.equal(L.fmtFactor(40_000), '×4')
  assert.equal(L.fmtFactor(25_000), '×2.5')
  assert.equal(L.fmtFactor(2_500), '×0.25')
  assert.equal(L.fmtFactor(1_000), '×0.1')
  assert.equal(L.fmtFactor(17_462), '×1.7')
})

test('names: implicit accounts shortened, named accounts by their first label, the player as you', () => {
  const hex = 'ab12' + '0'.repeat(56) + 'cd34'
  assert.equal(L.nameOf(hex, 'me'), 'ab12…cd34')
  assert.equal(L.nameOf('demo-bot-early-a.bonfire.testnet', 'me'), 'demo-bot-early-a')
  assert.equal(L.nameOf('a-very-long-account-label-here.testnet', 'me'), 'a-very-long-acco…')
  assert.equal(L.nameOf(hex, hex), 'you')
  assert.equal(L.nameOf(null, 'me'), '')
})

// ---- the ritual's arithmetic: the contract's own test numbers ---------------------------------------

test('clock night and windows follow genesis, night length and pool_windows', () => {
  assert.equal(L.clockNight(1000, 1000, 300_000), 1)
  assert.equal(L.clockNight(1000 + 300_000, 1000, 300_000), 2)
  assert.equal(L.windowAt(0, 300_000, 4), 0)
  assert.equal(L.windowAt(74_999, 300_000, 4), 0)
  assert.equal(L.windowAt(75_000, 300_000, 4), 1)
  assert.equal(L.windowAt(299_999, 300_000, 4), 3)
  assert.equal(L.windowAt(999_999, 300_000, 4), 3)
})

test('slice weight: as contract/src/math.rs computes it', () => {
  assert.equal(L.sliceWeight(1000n, 40_000, 0n, 1000n), 1000n * 25_000n, 'the whole target earns (4 + 1) / 2')
  assert.equal(L.sliceWeight(1000n, 40_000, 0n, 1n), 39_985n)
  assert.equal(L.sliceWeight(1000n, 40_000, 999n, 1n), 10_015n)
  assert.equal(L.sliceWeight(1000n, 40_000, 0n, 0n), 0n)
  // splitting the target into ten slices weighs (almost) the same as the whole
  const t = 1_000_000n
  const whole = L.sliceWeight(t, 40_000, 0n, t)
  let parts = 0n
  for (let i = 0n; i < 10n; i++) parts += L.sliceWeight(t, 40_000, (i * t) / 10n, t / 10n)
  assert.ok(whole - parts >= 0n && whole - parts <= 10n)
})

test('pooled windows: the numbers of tests/ritual.rs (a lit night)', () => {
  // 12,000 in window 0, 8,000 in window 1 (reaches 20,000), 4,000 late in window 2
  const ws = L.windowWeights([12_000n, 8_000n, 4_000n, 0n], 20_000n, 40_000, 2_500)
  assert.deepEqual(ws.map((w) => w.weight), [372_000_000n, 128_000_000n, 10_000_000n, 0n])
  assert.deepEqual(ws.map((w) => w.start), [0n, 12_000n, 20_000n, 24_000n])
  // founder 0's weight is its whole window
  assert.equal(L.weightOf(ws, [{ window: 0, wood: '12000' }]), 372_000_000n)
  // two throwers sharing window 0 pro rata
  assert.equal(L.weightOf(ws, [{ window: 0, wood: '3000' }]), 93_000_000n)
})

const cfg = {
  config: {
    symbol: 'EMBER',
    decimals: D,
    night_ms: 300_000,
    early_max_bp: 40_000,
    late_lit_bp: 2_500,
    pool_windows: 4,
    mint_bp: 400,
    hearth_cut_bp: 1000,
    smoke_bp: 300,
    min_throw: E(1).toString(),
    target_min: E(100).toString(),
    kindling: E(200).toString(),
    kindling_per_night: 1,
  },
  genesis_ms: 1_000_000,
  supply_cap: (1n << 112n).toString(),
}

/** A state view of night 3 (it runs from 1,600,000 to 1,900,000) with the given windows' wood. */
function state(woods = [E(300), 0n, 0n, 0n], over = {}) {
  const target = over.target ? L.big(over.target) : E(400)
  const ws = L.windowWeights(woods, target, 40_000, 2_500)
  const pile = woods.reduce((a, b) => a + b, 0n)
  return {
    night: 3,
    night_start_ms: 1_600_000,
    night_end_ms: 1_900_000,
    now_ms: 1_700_000,
    due: false,
    nights_due: 0,
    clock_night: 3,
    window_now: 1,
    window_end_ms: 1_750_000,
    windows: ws.map((w, i) => ({ window: i, wood: w.wood.toString(), start_pile: w.start.toString(), weight: w.weight.toString() })),
    target: target.toString(),
    pile: pile.toString(),
    throwers: 2,
    reached: pile >= target,
    firestarter: 'a.testnet',
    last_log: null,
    streak: 2,
    records: { longest_streak: 2 },
    hearth: E(890_000).toString(),
    supply: E(1_000_100).toString(),
    owed: '0',
    owed_nights: 0,
    kindling_left_tonight: 1,
    accounts_sponsored: 30,
    max_accounts: 4505,
    last: { night: 2, outcome: 'LIT', target: E(380).toString(), pile: E(420).toString() },
    ...over,
  }
}

const holder = (over = {}) => ({ registered: true, balance: E(500).toString(), credited: E(500).toString(), pending: '0', wood_night: null, wood: '0', wood_by_window: [], weight: '0', nonce: 3, sponsored: true, held: true, kindled: true, may_take_kindling: false, ...over })

test('estimateLocal mirrors the contract view: tests/ritual.rs numbers and the current window', () => {
  // decimals 0 and target 20,000 as in the contract tests, at the start of night 1
  const c0 = { config: { ...cfg.config, decimals: 0, target_min: '5000' }, genesis_ms: 0 }
  const empty = { night: 1, target: '20000', windows: [] }
  assert.equal(L.estimateLocal({ cfg: c0, state: empty, amount: 1n, nowMs: 0 }).weight, '39999')
  const whole = L.estimateLocal({ cfg: c0, state: empty, amount: 20_000n, nowMs: 0 })
  assert.deepEqual([whole.weight, whole.factor_bp, whole.window], [String(20_000 * 25_000), 25_000, 0])
  assert.equal(L.estimateLocal({ cfg: c0, state: empty, amount: 40_000n, nowMs: 0 }).weight, String(20_000 * 25_000 + 20_000 * 2_500))
  // night 3 at 1,700,000 is in window 1, on top of window 0's 300
  const e = L.estimateLocal({ cfg, state: state(), amount: E(50), nowMs: 1_700_000 })
  assert.equal(e.window, 1)
  assert.equal(e.night, 3)
  const expected = L.windowWeights([E(300), E(50), 0n, 0n], E(400), 40_000, 2_500)[1].weight
  assert.equal(e.weight, expected.toString())
  assert.ok(e.factor_bp < 40_000 && e.factor_bp > 10_000)
})

test('windows model: past, now and next quarters, the factor now, when the quarter closes', () => {
  const h = holder({ wood_night: 3, wood: E(100).toString(), wood_by_window: [{ window: 0, wood: E(100).toString() }] })
  const w = L.windowsModel({ cfg, state: state(), holder: h, nowMs: 1_700_000 })
  assert.equal(w.count, 4)
  assert.equal(w.current, 1)
  assert.deepEqual(w.segments.map((s) => s.when), ['past', 'now', 'next', 'next'])
  assert.equal(w.segments[0].mine, E(100))
  assert.equal(w.segments[1].mine, 0n)
  assert.equal(w.closesInMs, 50_000)
  // 300 on a 400 target: window 0's average factor is 4 - 3 * 300 / 800 = 2.875
  assert.equal(w.segments[0].factorBp, 28_750)
  // one EMBER now covers 300..301 of 400: 4 - 3 * (2 * 300 + 1) / 800 = 1.74625
  assert.equal(w.nowFactorBp, 17_462)
  assert.equal(w.segments[2].factorBp, null)
  const due = L.windowsModel({ cfg, state: state(), holder: h, nowMs: 1_900_000 })
  assert.equal(due.due, true)
  assert.equal(due.nowFactorBp, null)
  assert.ok(due.segments.every((s) => s.when === 'past'))
})

test('lit pool, expected reward and smoke loss as the contract rounds them', () => {
  const p = L.lightPool({ target: E(400), mintBp: 400, hearthCutBp: 1000 })
  assert.deepEqual([p.mint, p.cut, p.pool], [E(16), E('1.6'), E('14.4')])
  assert.equal(L.lightPool({ target: 1000n, mintBp: 500, hearthCutBp: 2000, supply: 990n, supplyCap: 1000n }).mint, 10n)
  assert.equal(L.expectedReward({ pool: 160n, myWeight: 1n, totalWeight: 3n }), 53n)
  assert.equal(L.expectedReward({ pool: 160n, myWeight: 0n, totalWeight: 3n }), 0n)
  // tests/ritual.rs: 3 % of 13,333 burns (399); 10,000 of it gets 9,700 back
  assert.equal(L.smokeLoss({ wood: 10_000n, pile: 13_333n, smokeBp: 300 }), 300n)
})

test('signing text and action JSON match the contract format', () => {
  assert.equal(L.signingText('bonfire-stage.testnet', 7, '{"collect":{"night":12}}'), 'bonfire:v1:bonfire-stage.testnet:7:{"collect":{"night":12}}')
  assert.equal(L.throwAction(5_000_000_000_000_000_000_000n, 12), '{"throw":{"amount":"5000000000000000000000","night":12}}')
  assert.equal(L.kindlingAction(12), '{"claim_kindling":{"night":12}}')
  assert.equal(L.collectAction(12), '{"collect":{"night":12}}')
})

test('nonces rise, follow the clock, and stay JS-safe', () => {
  assert.equal(L.nextNonce(0, 1_700_000_000_000), 1_700_000_000_000)
  assert.equal(L.nextNonce(1_800_000_000_000, 1_700_000_000_000), 1_800_000_000_001)
  assert.throws(() => L.nextNonce(Number.MAX_SAFE_INTEGER, 0))
})

test('throw choices: round amounts below the balance, plus All', () => {
  assert.deepEqual(L.throwChoices(E(2000), D, E(1)).map((x) => x.label), ['250', '500', '1,000', 'All'])
  assert.deepEqual(L.throwChoices(E(200), D, E(1)).map((x) => x.label), ['25', '50', '100', 'All'])
  assert.deepEqual(L.throwChoices(E(3), D, E(1)).map((x) => x.label), ['1', 'All'])
  assert.deepEqual(L.throwChoices(0n, D, E(1)), [])
  assert.deepEqual(L.throwChoices(E('0.5'), D, E(1)), [])
})

// ---- the model ------------------------------------------------------------------------------------

test('model: progress, gap, phase, names, and wood only from tonight', () => {
  const m = L.deriveModel({ cfg, state: state(), holder: holder(), nowMs: 1_750_000 })
  assert.equal(m.msLeft, 150_000)
  assert.equal(m.progress, 0.5)
  assert.equal(m.pct, 0.75)
  assert.equal(m.gap, E(100))
  assert.equal(m.phase, 'close')
  assert.equal(m.firestarter, 'a.testnet')
  assert.equal(m.canThrow, true)
  assert.equal(m.windows.current, 2)
  // wood of an earlier night is not tonight's wood
  const old = L.deriveModel({ cfg, state: state(), holder: holder({ wood_night: 2, wood: E(50).toString(), weight: '5' }), nowMs: 1_750_000 })
  assert.equal(old.myWood, 0n)
  assert.equal(old.myWeight, 0n)
})

test('model: phases empty, reached and due', () => {
  const at = (woods, now = 1_750_000) => L.deriveModel({ cfg, state: state(woods), holder: holder(), nowMs: now }).phase
  assert.equal(at([0n, 0n, 0n, 0n]), 'empty')
  assert.equal(at([E(400), 0n, 0n, 0n]), 'reached')
  assert.equal(at([E(100), 0n, 0n, 0n]), 'building')
  assert.equal(at([E(100), 0n, 0n, 0n], 1_900_000), 'due')
})

test('model: credit from a settled night is ready to collect, and counts in the balance', () => {
  const h = holder({ balance: E(620).toString(), credited: E(500).toString(), pending: E(120).toString(), wood_night: 2, wood: E(100).toString() })
  const m = L.deriveModel({ cfg, state: state(), holder: h, nowMs: 1_750_000 })
  assert.equal(m.pending, E(120))
  assert.equal(m.readyNight, 2)
  assert.equal(m.balance, E(620))
  assert.deepEqual(m.choices.map((c) => c.label), ['50', '100', '250', 'All'])
  const none = L.deriveModel({ cfg, state: state(), holder: holder(), nowMs: 1_750_000 })
  assert.equal(none.readyNight, null)
})

test('model: expected reward from the window weights', () => {
  const woods = [E(300), E(100), 0n, 0n]
  const ws = L.windowWeights(woods, E(400), 40_000, 2_500)
  const mine = [{ window: 0, wood: E(100).toString() }]
  const h = holder({ wood_night: 3, wood: E(100).toString(), wood_by_window: mine, weight: L.weightOf(ws, mine).toString() })
  const m = L.deriveModel({ cfg, state: state(woods), holder: h, nowMs: 1_800_000 })
  const total = ws.reduce((a, w) => a + w.weight, 0n)
  assert.equal(m.reward, (E('14.4') * L.weightOf(ws, mine)) / total)
  assert.equal(m.iThrew, true)
})

test('share preview from estimate: the throw adds its weight and the totals follow the window', () => {
  const m = L.deriveModel({ cfg, state: state(), holder: holder(), nowMs: 1_700_000 })
  const est = L.estimateLocal({ cfg, state: state(), amount: E(50), nowMs: 1_700_000 })
  const p = L.previewFromEstimate(m, est, cfg)
  const after = L.windowWeights([E(300), E(50), 0n, 0n], E(400), 40_000, 2_500)
  const total = after.reduce((a, w) => a + w.weight, 0n)
  assert.equal(p.weight, after[1].weight)
  assert.equal(p.factorBp, est.factor_bp)
  assert.equal(p.reward, (E('14.4') * after[1].weight) / total)
  assert.equal(p.gain, p.reward)
  // with wood already in the same window, the share grows by less than the new weight alone
  const mine = [{ window: 1, wood: E(50).toString() }]
  const ws = L.windowWeights([E(300), E(50), 0n, 0n], E(400), 40_000, 2_500)
  const h = holder({ wood_night: 3, wood: E(50).toString(), wood_by_window: mine, weight: L.weightOf(ws, mine).toString() })
  const st = state([E(300), E(50), 0n, 0n])
  const m2 = L.deriveModel({ cfg, state: st, holder: h, nowMs: 1_700_000 })
  const p2 = L.previewFromEstimate(m2, L.estimateLocal({ cfg, state: st, amount: E(50), nowMs: 1_700_000 }), cfg)
  assert.ok(p2.gain > 0n && p2.gain < p2.reward)
})

test('model: kindling availability and its reasons', () => {
  const fresh = { registered: false, balance: '0', credited: '0', pending: '0', wood_night: null, wood: '0', wood_by_window: [], weight: '0', nonce: 0, may_take_kindling: true, held: false, kindled: false }
  const k = (s) => L.deriveModel({ cfg, state: state(undefined, s), holder: fresh, nowMs: 1_750_000 }).kindle
  assert.deepEqual(k({}), { can: true, why: '' })
  assert.equal(k({ kindling_left_tonight: 0 }).why, 'gone')
  assert.equal(k({ hearth: E(100).toString() }).why, 'dry')
  assert.equal(k({ accounts_sponsored: 4505 }).why, 'full')
  assert.equal(L.deriveModel({ cfg, state: state(), holder: fresh, nowMs: 1_750_000 }).canThrow, false)
})

test('headline says what tonight needs', () => {
  const h = (woods, now = 1_750_000) => L.headline(L.deriveModel({ cfg, state: state(woods), holder: holder(), nowMs: now }))
  assert.equal(h([E(300), 0n, 0n, 0n]).big, '100 EMBER')
  assert.equal(h([0n, 0n, 0n, 0n]).big, '400 EMBER')
  assert.equal(h([E(450), 0n, 0n, 0n]).big, 'Enough wood')
  assert.equal(h([E(300), 0n, 0n, 0n], 1_950_000).big, 'Dawn')
})

// ---- outcomes and history -------------------------------------------------------------------------

test('outcome words as the coin face writes them; the strip counts the streak', () => {
  assert.equal(L.outcomeWord('LIT', 4), 'LIT ×4')
  assert.equal(L.outcomeWord('SMOKED', 0), 'SMOKED')
  assert.equal(L.outcomeWord('COLD', 0), 'COLD')
  const rows = ['LIT', 'LIT', 'SMOKED', 'LIT', 'LIT', 'LIT', 'COLD'].map((o, i) => ({ night: i + 1, target: E(400).toString(), pile: E(o === 'LIT' ? 420 : o === 'COLD' ? 0 : 200).toString(), outcome: o, minted: '0', burned: '0', supply: E(1_000_000 + i).toString() }))
  const s = L.nightStrip(rows, 5)
  assert.deepEqual(s.map((r) => r.night), [3, 4, 5, 6, 7])
  assert.deepEqual(s.map((r) => r.word), ['SMOKED', 'LIT ×1', 'LIT ×2', 'LIT ×3', 'COLD'])
  assert.equal(s[1].pct, 1.05)
  assert.equal(L.supplySeries(rows, D)[6].supply, 1_000_006)
  assert.equal(L.historyFrom(42, 24), 18)
  assert.equal(L.historyFrom(5, 24), 1)
})

test('night result: the player credit, the names, and the words for each outcome', () => {
  const nv = { night: 9, outcome: 'LIT', streak: 4, target: E(400).toString(), pile: E(460).toString(), throwers: 5, minted: E(16).toString(), hearth_cut: E('1.6').toString(), burned: '0', firestarter: 'demo-bot-early-a.bonfire.testnet', last_log: { account: 'me', amount: E(40).toString() } }
  const mine = holder({ wood_night: 9, wood: E(100).toString(), pending: E('103.5').toString() })
  const r = L.nightResult(nv, mine, 'me', D, 'EMBER')
  assert.equal(r.word, 'LIT ×4')
  assert.equal(r.text, 'Your 100 wood comes back, plus 3.5 new EMBER.')
  assert.equal(r.names, 'Firestarter demo-bot-early-a · last log you (40)')
  assert.equal(L.nightResult(nv, holder(), 'me', D, 'EMBER').text, '5 throwers shared 14.4 new EMBER.')
  const smoked = { ...nv, outcome: 'SMOKED', streak: 0, pile: E(300).toString(), burned: E(10).toString(), last_log: null }
  assert.equal(L.nightResult(smoked, holder({ wood_night: 9, wood: E(100).toString(), pending: E(97).toString() }), 'me', D, 'EMBER').text, '97 of your 100 wood comes back; 3 burned.')
  assert.equal(L.nightResult(smoked, holder(), 'me', D, 'EMBER').text, '300 of 400 wood was not enough. 10 EMBER burned.')
  const cold = L.nightResult({ ...nv, outcome: 'COLD', streak: 0, pile: '0', throwers: 0, firestarter: null, last_log: null }, holder(), 'me', D, 'EMBER')
  assert.equal(cold.word, 'COLD')
  assert.equal(cold.names, '')
})

// ---- people and collecting --------------------------------------------------------------------------

const recent = [
  { night: 2, window: 3, account: 'old.testnet', amount: E(30).toString(), pile: '0', at_ms: 1 },
  { night: 2, window: 3, account: 'me', amount: E(30).toString(), pile: '0', at_ms: 2 },
  { night: 3, window: 0, account: 'a.testnet', amount: E(100).toString(), pile: '0', at_ms: 3 },
  { night: 3, window: 1, account: 'b.testnet', amount: E(50).toString(), pile: '0', at_ms: 4 },
  { night: 3, window: 1, account: 'a.testnet', amount: E(20).toString(), pile: '0', at_ms: 5 },
]

test('throwers and seats come from recent throws of tonight, the player first', () => {
  const t = L.throwersFromRecent(recent, 3, 'me', E(10))
  assert.deepEqual(t.map((x) => [x.account, x.wood]), [['a.testnet', E(120)], ['b.testnet', E(50)], ['me', E(10)]])
  const s = L.seats(t, 'me', 2, 7)
  assert.deepEqual(s.shown.map((x) => x.account), ['me', 'a.testnet'])
  assert.equal(s.more, 5, 'seven throwers tonight, two shown')
  assert.equal(L.throwKey(recent[2]), '3:3:a.testnet:' + E(100))
})

test('collect candidates: settled nights only, never the player, each account once, newest first', () => {
  assert.deepEqual(L.collectCandidates(recent, 3, 'me', new Set(), 4), ['old.testnet'])
  assert.deepEqual(L.collectCandidates(recent, 4, 'me', new Set(), 4), ['a.testnet', 'b.testnet', 'old.testnet'])
  assert.deepEqual(L.collectCandidates(recent, 4, 'me', new Set(['a.testnet']), 1), ['b.testnet'])
  assert.deepEqual(L.collectCandidates([], 4, 'me', new Set(), 4), [])
})

test('only SVG data URLs pass as the coin icon', () => {
  assert.ok(L.safeIcon('data:image/svg+xml,%3Csvg%3E'))
  assert.equal(L.safeIcon('javascript:alert(1)'), null)
  assert.equal(L.safeIcon('https://example.com/x.svg'), null)
})
