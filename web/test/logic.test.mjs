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
  // the deployment's demo bots go by their labels, and the player is still "you"
  const bots = { [hex]: 'demo-bot-early-a' }
  assert.equal(L.nameOf(hex, 'me', bots), 'demo-bot-early-a')
  assert.equal(L.nameOf(hex, hex, bots), 'you')
  assert.equal(L.nameOf('constructor', 'me', bots), 'constructor', 'only own keys of the label map')
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

test('throw hint: the factor and the gain; when the player holds all the weight, what more wood does', () => {
  // nobody on tonight's pile yet but others: a throw gains a share
  const m = L.deriveModel({ cfg, state: state(), holder: holder(), nowMs: 1_700_000 })
  const p = L.previewFromEstimate(m, L.estimateLocal({ cfg, state: state(), amount: E(50), nowMs: 1_700_000 }), cfg)
  assert.equal(L.throwHint(m, E(50), p), `Throw 50 now: it counts ${L.fmtFactor(p.factorBp)}, about +${L.fmtEmber(p.gain, D)} new EMBER if the fire catches.`)
  // the player alone on the pile: the whole mint is already its own, so the gain is 0
  const woods = [E(50), 0n, 0n, 0n]
  const ws = L.windowWeights(woods, E(400), 40_000, 2_500)
  const mine = [{ window: 0, wood: E(50).toString() }]
  const alone = holder({ wood_night: 3, wood: E(50).toString(), wood_by_window: mine, weight: L.weightOf(ws, mine).toString() })
  const st = state(woods, { throwers: 1 })
  const m2 = L.deriveModel({ cfg, state: st, holder: alone, nowMs: 1_700_000 })
  const p2 = L.previewFromEstimate(m2, L.estimateLocal({ cfg, state: st, amount: E(25), nowMs: 1_700_000 }), cfg)
  assert.equal(p2.gain, 0n)
  assert.equal(L.throwHint(m2, E(25), p2), `Throw 25 now: it counts ${L.fmtFactor(p2.factorBp)}. Tonight's new EMBER is all yours so far; more wood helps the fire catch.`)
  assert.ok(!/\+0 new/.test(L.throwHint(m2, E(25), p2)))
  // a gain that rounds to nothing for someone who is not alone
  assert.equal(L.throwHint(m, 1n, { ...p, gain: 0n }), `Throw 0.000000000000000001 now: it counts ${L.fmtFactor(p.factorBp)}. Too little to change your share of the new EMBER.`)
})

test('ready to collect: the credit is said to be in the balance already, which counts it', () => {
  const h = holder({ balance: E(620).toString(), credited: E(500).toString(), pending: E(120).toString(), wood_night: 2, wood: E(100).toString() })
  const m = L.deriveModel({ cfg, state: state(), holder: h, nowMs: 1_750_000 })
  assert.equal(m.balance, m.credited + m.pending)
  assert.equal(L.readyText(m), 'from night 2 is already in your balance. Collect it now, or your next throw will.')
})

test('kindling handed out: the newcomer is told when the next claim opens', () => {
  assert.equal(L.kindlingNote('gone', 192_000), 'Tonight’s kindling is handed out. The next claim opens at dawn, in 3:12.')
  assert.equal(L.kindlingNote('dry', 0), 'The hearth has no kindling left.')
  assert.equal(L.kindlingNote('claimed', 0), 'You have no free EMBER right now.')
  assert.equal(L.kindlingNote('', 0), '')
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

// ---- a first visit, the streak at risk, the player's own tally --------------------------------------

const newcomer = { registered: false, balance: '0', credited: '0', pending: '0', wood_night: null, wood: '0', wood_by_window: [], weight: '0', nonce: 0, may_take_kindling: true, held: false, kindled: false }

test('intro: the three steps follow the player from kindling to the throw to dawn', () => {
  const at = (h, over = {}, now = 1_750_000, pendingWood) => L.introSteps(L.deriveModel({ cfg, state: state(undefined, over), holder: h, nowMs: now }), pendingWood)
  const first = at(newcomer)
  assert.equal(first.at, 1)
  assert.deepEqual(first.steps.map((s) => s.state), ['now', 'next', 'next'])
  assert.deepEqual(first.steps.map((s) => s.title), ['Get kindling', 'Throw before dawn', 'See it catch at dawn'])
  assert.equal(first.steps[0].sub, 'free, no wallet, no sign-up')
  assert.equal(first.steps[2].sub, 'dawn in 2:30', 'the third step counts down to dawn')
  // kindling arrived: throw next
  const kindled = at({ ...newcomer, registered: true, balance: E(200).toString(), credited: E(200).toString(), held: true, kindled: true, may_take_kindling: false })
  assert.equal(kindled.at, 2)
  assert.deepEqual(kindled.steps.map((s) => s.state), ['done', 'now', 'next'])
  // wood on tonight's pile, or a throw still on its way: wait for dawn
  const threw = at(holder({ wood_night: 3, wood: E(50).toString(), wood_by_window: [{ window: 1, wood: E(50).toString() }] }))
  assert.deepEqual(threw.steps.map((s) => s.state), ['done', 'done', 'now'])
  assert.equal(at(holder(), {}, 1_750_000, E(25)).at, 3)
  // tonight's kindling is gone: the first step says when the next claim opens
  assert.equal(at(newcomer, { kindling_left_tonight: 0 }).steps[0].sub, 'handed out tonight; the next claim opens at dawn')
  assert.equal(at(newcomer, {}, 1_900_000).steps[2].sub, 'dawn is breaking')
})

test('streak at risk: only in the last quarter, with a streak running and the pile short', () => {
  const risk = (woods, over = {}, now = 1_850_000) => L.streakRisk(L.deriveModel({ cfg, state: state(woods, over), holder: holder(), nowMs: now }))
  // night 3 runs 1,600,000 to 1,900,000; its last quarter starts at 1,825,000
  const r = risk([E(300), 0n, 0n, 0n])
  assert.equal(r.text, 'The streak of 2 nights ends at dawn unless 100 more wood lands.')
  assert.equal(r.need, 100n)
  assert.equal(risk([E(300), 0n, 0n, 0n], { streak: 1 }).text, 'The streak of 1 night ends at dawn unless 100 more wood lands.')
  // the wood is rounded up: 99.6 short needs 100
  assert.equal(risk([E('300.4'), 0n, 0n, 0n]).need, 100n)
  assert.equal(risk([0n, 0n, 0n, 0n]).need, 400n, 'an empty pile ends the streak too')
  assert.equal(risk([E(300), 0n, 0n, 0n], {}, 1_824_999), null, 'not before the last quarter')
  assert.equal(risk([E(300), 0n, 0n, 0n], { streak: 0 }), null, 'no streak, nothing at risk')
  assert.equal(risk([E(400), 0n, 0n, 0n]), null, 'the target is reached')
  assert.equal(risk([E(300), 0n, 0n, 0n], {}, 1_900_000), null, 'dawn has come')
})

test('own dawn: once the player has wood tonight, the line counts down to dawn and names the wood', () => {
  const line = (h, now = 1_750_000, pendingWood) => L.dawnLine(L.deriveModel({ cfg, state: state(), holder: h, nowMs: now }), pendingWood)
  const threw = holder({ wood_night: 3, wood: E(50).toString(), wood_by_window: [{ window: 1, wood: E(50).toString() }] })
  assert.equal(line(holder()), null, 'no wood tonight, no line')
  assert.equal(line(holder({ wood_night: 2, wood: E(50).toString() })), null, 'wood of an earlier night is not tonight')
  assert.deepEqual(line(threw), { due: false, when: 'Dawn in 2:30', what: 'your 50 wood on the pile', tab: '2:30 to dawn' })
  assert.equal(line(holder(), 1_750_000, E(25)).what, 'your 25 wood on its way to the pile', 'a throw not yet in the views')
  assert.equal(line(threw, 1_750_000, E(25)).what, 'your 75 wood on the pile')
  assert.deepEqual(line(threw, 1_900_000), { due: true, when: 'Dawn', what: 'lighting the fire with your 50 wood…', tab: 'Dawn' })
})

test('own dawn: the chime rings once at the dawn of the night the player threw on, never otherwise', () => {
  const waiting = { due: false, tab: '0:05 to dawn' }
  const dawn = { due: true, tab: 'Dawn' }
  let c = L.dawnCue(null, 3, waiting)
  assert.deepEqual(c, { armed: 3, ring: false })
  c = L.dawnCue(c.armed, 3, dawn)
  assert.deepEqual(c, { armed: null, ring: true }, 'the clock reaches dawn')
  assert.deepEqual(L.dawnCue(c.armed, 3, dawn), { armed: null, ring: false }, 'once')
  assert.deepEqual(L.dawnCue(3, 4, null), { armed: null, ring: true }, 'the settled state came before the clock showed dawn')
  assert.deepEqual(L.dawnCue(3, 3, null), { armed: null, ring: false }, 'a refused throw: no wood landed, no chime')
  assert.deepEqual(L.dawnCue(null, 3, dawn), { armed: null, ring: false }, 'a page opened after dawn does not ring')
  assert.deepEqual(L.dawnCue(null, 3, null), { armed: null, ring: false })
})

test('own dawn: the tab title carries the countdown or the result only while the tab is hidden', () => {
  const base = 'Bonfire · EMBER'
  const dawn = { due: false, tab: '2:30 to dawn' }
  assert.equal(L.tabTitle(base, { hidden: false, dawn, result: 'Up in smoke' }), base)
  assert.equal(L.tabTitle(base, { hidden: true, dawn }), '2:30 to dawn · Bonfire · EMBER')
  assert.equal(L.tabTitle(base, { hidden: true, dawn: { due: true, tab: 'Dawn' } }), 'Dawn · Bonfire · EMBER')
  assert.equal(L.tabTitle(base, { hidden: true, dawn, result: 'The fire caught!' }), 'The fire caught! · Bonfire · EMBER')
  assert.equal(L.tabTitle(base, { hidden: true }), base)
})

test('headcount: the demo bots by their labels, and every other account by its kindling claim', () => {
  const labels = { ['a'.repeat(64)]: 'demo-bot-early-a', ['b'.repeat(64)]: 'demo-bot-early-b' }
  const founders = Object.keys(labels).map((account_id) => ({ account_id, amount: '1' }))
  const live = L.headcount({ founders, labels, kindlingClaims: 3 })
  assert.equal(live.text, 'Players so far: 2 labelled demo bots and 3 other accounts that claimed kindling')
  assert.deepEqual([live.bots, live.otherFounders, live.claims], [2, 0, 3])
  assert.equal(L.headcount({ founders, labels, kindlingClaims: 3, meKindled: true }).text, 'Players so far: 2 labelled demo bots and 3 other accounts that claimed kindling, you among them')
  assert.equal(L.headcount({ founders, labels, kindlingClaims: 1, meKindled: true }).text, 'Players so far: 2 labelled demo bots and 1 other account that claimed kindling: you')
  assert.equal(L.headcount({ founders, labels, kindlingClaims: 0 }).text, 'Players so far: 2 labelled demo bots and no other account yet')
  // founders that are not bots are named as such (the mock world has made-up founders)
  const mixed = [{ account_id: 'demo-bot-late.bonfire.testnet' }, { account_id: 'c'.repeat(64) }, { account_id: 'd'.repeat(64) }]
  assert.equal(L.headcount({ founders: mixed, labels: {}, kindlingClaims: 2 }).text, 'Players so far: 1 labelled demo bot, 2 other founding accounts and 2 accounts that claimed kindling')
  assert.equal(L.headcount({ founders: [], kindlingClaims: 0 }).text, 'Players so far: nobody yet')
})

test('credit from night(n): the contract credit_of numbers of tests/ritual.rs', () => {
  // a lit night: 12,000 / 8,000 / 4,000 wood on a 20,000 target; 4 % minted, 10 % of it to the hearth
  const ws = L.windowWeights([12_000n, 8_000n, 4_000n, 0n], 20_000n, 40_000, 2_500)
  const lit = { night: 7, outcome: 'LIT', pile: '24000', minted: '800', hearth_cut: '80', burned: '0', hearth_burned: '0', windows: ws.map((w, i) => ({ window: i, wood: w.wood.toString(), weight: w.weight.toString() })) }
  const share = L.expectedReward({ pool: 720n, myWeight: 93_000_000n, totalWeight: 510_000_000n })
  assert.equal(share, 131n)
  assert.equal(L.creditFromNight(lit, [[0, '3000']]), 3_131n)
  assert.equal(L.creditFromNight(lit, [[0, '12000'], [1, '8000'], [2, '4000']]), 24_720n, 'all the wood gets the whole pool')
  // a smoky night: 3 % of 13,333 burns (399); 10,000 of it gets 9,700 back
  const smoked = { night: 8, outcome: 'SMOKED', pile: '13333', minted: '0', hearth_cut: '0', burned: '404', hearth_burned: '5', windows: [] }
  assert.equal(L.creditFromNight(smoked, [[1, '10000']]), 9_700n)
  assert.equal(L.creditFromNight(null, [[1, '10']]), 10n)
})

test('tally: what the page saw of the player, settled by holder(me) or night(n)', () => {
  const by = (w, a) => [{ window: w, wood: E(a).toString() }]
  // night 3 is open: the wood is noted, nothing is settled yet
  let t = L.tallySee(null, holder({ wood_night: 3, wood: E(50).toString(), wood_by_window: by(1, 50) }), 3)
  assert.deepEqual(t.nights[3], { wood: E(50).toString(), by: [[1, E(50).toString()]] })
  assert.deepEqual(L.tallyOpen(t, 3), [])
  assert.deepEqual(L.tallyOpen(t, 4), [3])
  assert.equal(L.tallySummary(t, D, 'EMBER'), null, 'no settled night yet')
  // dawn: holder(me) shows what night 3 owes
  t = L.tallySee(t, holder({ wood_night: 3, wood: E(50).toString(), wood_by_window: by(1, 50), pending: E('53.2').toString() }), 4, (n) => (n === 3 ? 'LIT' : null))
  assert.equal(t.nights[3].out, 'LIT')
  assert.equal(t.nights[3].credit, E('53.2').toString())
  assert.equal(L.tallySummary(t, D, 'EMBER').text, 'You helped light a fire · 50 wood thrown · +3.2 new EMBER')
  // a settled night is not rewritten, and a holder without wood changes nothing
  assert.equal(L.tallySee(t, holder({ wood_night: 3, wood: E(50).toString(), pending: E(99).toString() }), 4).nights[3].credit, E('53.2').toString())
  assert.deepEqual(L.tallySee(t, holder(), 4), t)
  // night 5 was collected before the page saw it: night(5) settles it
  t = L.tallySee(t, holder({ wood_night: 5, wood: E(100).toString(), wood_by_window: by(0, 100) }), 5)
  assert.deepEqual(L.tallyOpen(t, 6), [5])
  const smoke = { night: 5, outcome: 'SMOKED', pile: E(200).toString(), burned: E(7).toString(), hearth_burned: E(1).toString(), minted: '0', hearth_cut: '0', windows: [] }
  t = L.tallyResolve(t, 5, smoke)
  assert.equal(t.nights[5].credit, E(97).toString(), '3 % of the pile burned')
  // night 6 is past what night(n) keeps: the outcome stays, the payout is unknown
  t = L.tallySee(t, holder({ wood_night: 6, wood: E(20).toString(), wood_by_window: by(2, 20) }), 6)
  t = L.tallyResolve(t, 6, null, 'LIT')
  assert.deepEqual([t.nights[6].out, t.nights[6].credit], ['LIT', null])
  const s = L.tallySummary(JSON.parse(JSON.stringify(t)), D, 'EMBER')
  assert.deepEqual([s.nights, s.lit, s.wood, s.earned, s.lost], [3, 2, E(170), E('3.2'), E(3)])
  assert.equal(s.text, 'You helped light 2 of 3 fires · 170 wood thrown · +3.2 new EMBER · 3 burned')
  // only smoke
  const lone = L.tallyResolve(L.tallySee(null, holder({ wood_night: 5, wood: E(100).toString(), wood_by_window: by(0, 100) }), 5), 5, smoke)
  assert.equal(L.tallySummary(lone, D, 'EMBER').text, 'Your fire went up in smoke · 100 wood thrown · 3 burned')
  // the oldest nights drop out beyond TALLY_KEEP
  let many = null
  for (let n = 1; n <= L.TALLY_KEEP + 5; n++) many = L.tallySee(many, holder({ wood_night: n, wood: '1', wood_by_window: [{ window: 0, wood: '1' }] }), n)
  assert.equal(Object.keys(many.nights).length, L.TALLY_KEEP)
  assert.ok(!many.nights[5] && many.nights[6] && many.nights[L.TALLY_KEEP + 5])
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
  const flows = L.flowSeries(rows.map((r, i) => ({ ...r, minted: E(i).toString(), burned: E(r.outcome === 'SMOKED' ? 7 : 0).toString() })), D, 4)
  assert.deepEqual(flows.map((f) => [f.night, f.word, f.mint, f.burn]), [[4, 'LIT ×1', 3, 0], [5, 'LIT ×2', 4, 0], [6, 'LIT ×3', 5, 0], [7, 'COLD', 6, 0]])
  assert.equal(L.flowSeries(rows.map((r) => ({ ...r, burned: E(7).toString() })), D)[2].burn, 7, 'all of them by default (up to 60)')
  assert.equal(L.historyFrom(42, 24), 18)
  assert.equal(L.historyFrom(5, 24), 1)
})

test('night result: the player credit, the names, and the words for each outcome', () => {
  const nv = { night: 9, outcome: 'LIT', streak: 4, target: E(400).toString(), pile: E(460).toString(), throwers: 5, minted: E(16).toString(), hearth_cut: E('1.6').toString(), burned: '0', firestarter: 'demo-bot-early-a.bonfire.testnet', last_log: { account: 'me', amount: E(40).toString() } }
  const mine = holder({ wood_night: 9, wood: E(100).toString(), pending: E('103.5').toString() })
  const r = L.nightResult(nv, mine, 'me', D, 'EMBER')
  assert.equal(r.word, 'LIT ×4')
  assert.equal(r.text, 'Your 100 wood comes back, plus 3.5 new EMBER.')
  assert.equal(r.names, 'Firestarter: demo-bot-early-a · Last log: you (40)')
  const bot = 'f057' + '0'.repeat(56) + '6bb0'
  const byBot = L.nightResult({ ...nv, firestarter: bot, last_log: { account: bot, amount: E(40).toString() } }, holder(), 'me', D, 'EMBER', { [bot]: 'demo-bot-early-b' })
  assert.equal(byBot.names, 'Firestarter: demo-bot-early-b · Last log: demo-bot-early-b (40)')
  assert.equal(L.nightResult({ ...nv, firestarter: bot, last_log: null }, holder(), 'me', D, 'EMBER').names, 'Firestarter: f057…6bb0')
  assert.equal(L.nightResult(nv, holder(), 'me', D, 'EMBER').text, '5 throwers shared 14.4 new EMBER.')
  const smoked = { ...nv, outcome: 'SMOKED', streak: 0, pile: E(300).toString(), burned: E(10).toString(), last_log: null }
  assert.equal(L.nightResult(smoked, holder({ wood_night: 9, wood: E(100).toString(), pending: E(97).toString() }), 'me', D, 'EMBER').text, '97 of your 100 wood comes back; 3 burned.')
  assert.equal(L.nightResult(smoked, holder(), 'me', D, 'EMBER').text, '300 of 400 wood was not enough. 10 EMBER burned.')
  const cold = L.nightResult({ ...nv, outcome: 'COLD', streak: 0, pile: '0', throwers: 0, firestarter: null, last_log: null }, holder(), 'me', D, 'EMBER')
  assert.equal(cold.word, 'COLD')
  assert.equal(cold.names, '')
})

test('the moon keeps to the side of the sky: right of the text, above "Your wood", clear of the fire', () => {
  // desktop 1440 x 900: the rules end at x 1040, the card spans 1076..1412 from y 300, the header ends at 60
  const m = L.moonPath({ W: 1440, H: 900, text: { right: 1040, bottom: 228 }, card: { top: 300, right: 1412 }, top: 60, r: 21 })
  assert.ok(m.x0 - 21 > 1040, 'never behind the rules')
  assert.ok(m.x0 >= 0.74 * 1440 && m.x1 <= 0.9 * 1440 && m.x1 >= m.x0)
  assert.ok(m.y + 21 < 300 && m.y - m.lift - 21 > 60, 'between the header and the card, also at midnight')
  // a card that grew up to the header still leaves the moon between them, without a lift
  const tight = L.moonPath({ W: 1280, H: 720, text: { right: 960, bottom: 230 }, card: { top: 120, right: 1262 }, top: 60, r: 20 })
  assert.equal(tight.lift, 0)
  assert.equal(tight.y, 90)
  // phone: under the sky text, on the right, above the horizon (60 % of a 540 px stage)
  const p = L.moonPath({ W: 390, H: 540, text: { right: 370, bottom: 270 }, card: null, r: 14 })
  assert.ok(p.y - 14 > 270 && p.y < 0.62 * 540)
  assert.ok(p.x0 >= 0.8 * 390 && p.x1 + 14 <= 0.95 * 390 && p.x1 >= p.x0)
  assert.equal(p.lift, 0)
})

test('dawn: a page waits a random moment and settles only while the chain has a night due', () => {
  assert.equal(L.settleDelay(() => 0), 0)
  assert.equal(L.settleDelay(() => 0.5), L.SETTLE_JITTER_MS / 2)
  assert.ok(L.SETTLE_JITTER_MS >= 5000, 'wider than the second or two a settle takes to show in the views')
  assert.ok(L.settleDelay(() => 1) < L.SETTLE_JITTER_MS)
  for (let i = 0; i < 50; i++) {
    const d = L.settleDelay()
    assert.ok(d >= 0 && d < L.SETTLE_JITTER_MS)
  }
  assert.equal(L.settleNeeded(state(undefined, { due: true, nights_due: 1 })), true)
  // another visitor settled first: the view moved on and nothing is due
  assert.equal(L.settleNeeded(state(undefined, { due: false, nights_due: 0 })), false)
  assert.equal(L.settleNeeded(null), false)
  assert.equal(L.settleNeeded(state(undefined, { due: true, nights_due: 1 }), true), false, 'a hidden tab leaves it to others')
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

test('collecting for others: throwers already collected do not use up the round', async () => {
  const pending = { late: 0n, steady: 0n, a: E(5), b: E(7), c: E(9) }
  const sent = []
  const tried = new Set()
  const n = await L.helpCollectRound({ candidates: ['late', 'steady', 'a', 'b', 'c'], tried, max: 2, pendingOf: async (x) => pending[x], collect: async (x) => sent.push(x) })
  // before, the round took the first two candidates only, both already collected, and relayed nothing
  assert.equal(n, 2)
  assert.deepEqual(sent, ['a', 'b'])
  assert.deepEqual([...tried], ['late', 'steady', 'a', 'b'])
  const errors = []
  const m = await L.helpCollectRound({ candidates: ['c', 'a'], tried: new Set(), max: 2, pendingOf: async () => E(1), collect: async () => { throw new Error('relay busy') }, onError: (x, e) => errors.push(`${x}: ${e.message}`) })
  assert.equal(m, 0)
  assert.deepEqual(errors, ['c: relay busy'], 'stops at the first error')
})

test('only SVG data URLs pass as the coin icon', () => {
  assert.ok(L.safeIcon('data:image/svg+xml,%3Csvg%3E'))
  assert.equal(L.safeIcon('javascript:alert(1)'), null)
  assert.equal(L.safeIcon('https://example.com/x.svg'), null)
})

test('storage that throws or is missing: the page reads nothing and forgets, without an error', () => {
  const box = new Map()
  const ok = L.safeStore(() => ({ getItem: (k) => box.get(k) ?? null, setItem: (k, v) => box.set(k, v) }))
  assert.equal(ok.get('a'), null)
  assert.equal(ok.set('a', 1), true)
  assert.equal(ok.get('a'), '1')
  const refusing = L.safeStore(() => ({ getItem: () => { throw new Error('SecurityError') }, setItem: () => { throw new Error('QuotaExceeded') } }))
  assert.equal(refusing.get('a'), null)
  assert.equal(refusing.set('a', 1), false)
  const blocked = L.safeStore(() => { throw new Error('access denied') })
  assert.equal(blocked.get('a'), null)
  assert.equal(blocked.set('a', 1), false)
  assert.equal(L.safeStore(undefined).get('a'), null)
})

test('the replay of last night plays on a first visit only, for a night that caught or smoked', () => {
  const last = { night: 30, outcome: 'LIT', pile: E(420).toString(), target: E(400).toString() }
  assert.equal(L.replayWanted({ seen: null, last, night: 31 }), true)
  assert.equal(L.replayWanted({ seen: '1731080000000', last, night: 31 }), false, 'seen before in this browser')
  assert.equal(L.replayWanted({ seen: null, reduced: true, last, night: 31 }), false, 'reduced motion: no film')
  assert.equal(L.replayWanted({ seen: null, last: { ...last, outcome: 'SMOKED' }, night: 31 }), true)
  assert.equal(L.replayWanted({ seen: null, last: { ...last, outcome: 'COLD', pile: '0' }, night: 31 }), false)
  assert.equal(L.replayWanted({ seen: null, last: { ...last, pile: '0' }, night: 31 }), false)
  assert.equal(L.replayWanted({ seen: null, last: null, night: 1 }), false, 'the first night is still burning')
  assert.equal(L.replayWanted({ seen: null, last, night: 30 }), false, 'not the open night')
})

test('the dawn stamp says what the coin face says', () => {
  assert.deepEqual(L.stampFor('LIT', 'LIT ×2'), { text: 'LIT ×2', kind: 'lit' })
  assert.deepEqual(L.stampFor('LIT', undefined), { text: 'LIT', kind: 'lit' })
  assert.deepEqual(L.stampFor('LIT', '<b>'), { text: 'LIT', kind: 'lit' })
  assert.deepEqual(L.stampFor('SMOKED', 'SMOKED'), { text: 'SMOKED', kind: 'smoked' })
  assert.deepEqual(L.stampFor('COLD'), { text: 'COLD', kind: 'cold' })
  assert.equal(L.stampFor('OPEN'), null)
})

test('sound comes on with the first tap only for a player who never chose', () => {
  assert.equal(L.soundOnFirstTap(null), true)
  assert.equal(L.soundOnFirstTap('off'), false)
  assert.equal(L.soundOnFirstTap('on'), false)
})
