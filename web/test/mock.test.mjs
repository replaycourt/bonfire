// The mock engine must settle like the contract, or the page would be tuned to a fantasy. The exact
// numbers below are those of contract/tests/ritual.rs (whole EMBER, decimals 0).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as L from '../js/logic.js'
import { MockEngine, MockWorld, buildMock, drawIcon, iconDataUrl, mockConfig } from '../js/mock.js'

const NIGHT = 300_000
const G = 1_000_000
const at = (n, permille) => G + (n - 1) * NIGHT + (NIGHT * permille) / 1000
const F = (i) => `founder${i}.testnet`

/** The contract tests' configuration: the launch values in whole EMBER, six founders of 100,000. */
function engine(over = {}) {
  const cfg = {
    ...mockConfig(NIGHT),
    decimals: 0,
    hearth_genesis: '400000',
    target_start: '20000',
    target_min: '5000',
    min_throw: '50',
    kindling: '250',
    kindling_per_night: 10,
    log_keep: 14,
    max_accounts: 1000,
    ...over,
  }
  return new MockEngine(cfg, Array.from({ length: 6 }, (_, i) => ({ account_id: F(i), amount: 100_000n })), G)
}

const conserved = (e) => assert.ok(e.audit().balanced && e.audit().ledger, 'supply = balances + pile + hearth + owed')

test('a lit night owes wood back and the mint by weight (tests/ritual.rs)', () => {
  const e = engine()
  e.throw(F(0), 12_000n, at(1, 0))
  e.throw(F(1), 8_000n, at(1, 300))
  e.throw(F(2), 4_000n, at(1, 600))
  const s = e.stateView(at(1, 700))
  assert.equal(s.firestarter, F(0))
  assert.deepEqual(s.last_log, { account: F(1), amount: '8000' })
  assert.deepEqual(s.windows.map((w) => w.weight), ['372000000', '128000000', '10000000', '0'])
  assert.equal(s.windows[2].start_pile, '20000')
  conserved(e)

  e.catchUp(at(2, 0))
  const t = e.stateView(at(2, 0))
  assert.deepEqual([t.hearth, t.supply, t.target, t.streak], ['400080', '1000800', '21400', 1])
  assert.equal(t.owed, String(24_000 + 720))
  const h = e.holderView(F(0))
  assert.deepEqual([h.credited, h.pending, h.balance, h.weight], ['88000', '12525', '100525', '372000000'])
  assert.equal(e.holderView(F(1)).balance, '100180')
  assert.equal(e.holderView(F(2)).balance, '100014')
  const n = e.nightView(1)
  assert.deepEqual([n.outcome, n.minted, n.hearth_cut, n.throwers, n.uncollected], ['LIT', '800', '80', 3, 3])
  assert.equal(n.last_log.account, F(1))
  conserved(e)

  for (let i = 0; i < 6; i++) e.collect(F(i), at(2, 1))
  const u = e.stateView(at(2, 1))
  assert.deepEqual([u.hearth, u.owed, u.owed_nights], ['400081', '0', 0], 'the last collection moves the dust')
  assert.equal(e.holderView(F(0)).credited, '100525')
  assert.equal(e.nightView(1).uncollected, 0)
  conserved(e)
})

test('a smoky night burns part of the pile; the hearth burn is capped by the mint (tests/ritual.rs)', () => {
  const e = engine()
  e.throw(F(0), 10_000n, at(1, 0))
  e.throw(F(1), 3_333n, at(1, 0))
  e.catchUp(at(2, 0))
  const s = e.stateView(at(2, 0))
  assert.deepEqual([s.hearth, s.supply, s.target, s.streak], ['399200', String(1_000_000 - 399 - 800), '18000', 0])
  assert.equal(e.holderView(F(0)).balance, '99700')
  assert.equal(e.holderView(F(1)).balance, '99900')
  const n = e.nightView(1)
  assert.deepEqual([n.outcome, n.burned, n.hearth_burned], ['SMOKED', '1199', '800'])
  for (let i = 0; i < 6; i++) e.collect(F(i), at(2, 1))
  assert.equal(e.stateView(at(2, 1)).hearth, '399201')
  conserved(e)
})

test('a small hearth burns its share below the cap; a cold night burns nothing', () => {
  const e = engine({ hearth_genesis: '100000' })
  e.throw(F(0), 1_000n, at(1, 0))
  e.catchUp(at(2, 0))
  assert.equal(e.nightView(1).hearth_burned, '250')
  const c = engine()
  c.catchUp(at(2, 0))
  const s = c.stateView(at(2, 0))
  assert.deepEqual([s.hearth, s.supply, s.target, s.streak], ['400000', '1000000', '18000', 0])
  assert.equal(c.nightView(1).outcome, 'COLD')
  assert.equal(s.records.nights_cold, 1)
})

test('estimate: the weight falls with the pile and the whole target earns the average (tests/ritual.rs)', () => {
  const e = engine()
  assert.equal(e.estimateView(1n, at(1, 0)).weight, '39999')
  const w = e.estimateView(20_000n, at(1, 0))
  assert.deepEqual([w.weight, w.factor_bp, w.window], [String(20_000 * 25_000), 25_000, 0])
  assert.equal(e.estimateView(40_000n, at(1, 0)).weight, String(20_000 * 25_000 + 20_000 * 2_500))
  // and the page's own estimate agrees with the engine at any point
  e.throw(F(0), 7_000n, at(1, 100))
  const now = at(1, 400)
  const local = L.estimateLocal({ cfg: e.configView(), state: e.stateView(now), amount: 3_000n, nowMs: now })
  assert.deepEqual(local, e.estimateView(3_000n, now))
})

test('wood is credited before the next throw, and a holder is owed for one night at most', () => {
  const e = engine()
  e.throw(F(0), 1_000n, at(1, 0))
  e.throw(F(1), 19_500n, at(1, 0))
  e.catchUp(at(2, 0))
  const before = e.holderView(F(0))
  assert.equal(before.wood_night, 1)
  assert.ok(BigInt(before.pending) > 1_000n)
  const out = e.throw(F(0), 100n, at(2, 10))
  assert.equal(out.ok.collected, before.pending)
  const after = e.holderView(F(0))
  assert.deepEqual([after.wood_night, after.wood, after.pending], [2, '100', '0'])
  assert.deepEqual(after.wood_by_window, [{ window: 0, wood: '100' }])
  conserved(e)
})

test('refusals: an ended night waits for settle, unknown accounts, too little, below min_throw', () => {
  const e = engine()
  assert.match(e.throw(F(0), 100n, at(2, 0)).error, /settle/)
  assert.match(e.throw('x.testnet', 100n, at(1, 0)).error, /not registered/)
  assert.match(e.throw(F(0), 200_000n, at(1, 0)).error, /not enough/)
  assert.match(e.throw(F(0), 10n, at(1, 0)).error, /smallest throw/)
})

test('kindling: once per account, capped per night, only for accounts that never held EMBER', () => {
  const e = engine({ kindling_per_night: 2 })
  assert.ok(e.claimKindling('k0', at(1, 0)).ok)
  assert.ok(e.claimKindling('k1', at(1, 0)).ok)
  assert.match(e.claimKindling('k2', at(1, 0)).error, /handed out/)
  assert.ok(e.claimKindling('k2', at(2, 0)).ok)
  assert.match(e.claimKindling('k0', at(2, 0)).error, /never held/)
  assert.equal(e.holderView('fresh').may_take_kindling, true)
})

test('recent throws keep the last 16, oldest first', () => {
  const e = engine()
  for (let i = 0; i < 20; i++) e.throw(F(i % 6), BigInt(100 + i), at(1, i * 10))
  const r = e.recentView()
  assert.equal(r.length, 16)
  assert.equal(r[0].amount, '104')
  assert.equal(r[15].amount, '119')
  assert.equal(r[15].window, 0)
})

test('a month of scheduled play keeps every EMBER accounted for and mixes the outcomes', () => {
  const w = new MockWorld({ nightMs: NIGHT, genesisMs: G, seed: 3 })
  w.advance(G + 60 * NIGHT + 5)
  const e = w.engine
  assert.ok(e.night >= 55, `night ${e.night}`)
  conserved(e)
  assert.ok(e.records.nights_lit > 15, `lit ${e.records.nights_lit}`)
  assert.ok(e.records.nights_smoked + e.records.nights_cold > 3, `smoked ${e.records.nights_smoked}`)
})

test('presets put the page in the state they promise', () => {
  const now = 1_800_000_000_000
  const me = 'f'.repeat(64)
  const first = buildMock({ scene: 'first', now, me }).engine
  assert.equal(first.night, 1)
  assert.equal(first.pile, 0n)
  assert.equal(first.historyView().length, 0)
  assert.equal(first.holderView(me).may_take_kindling, true)

  const close = buildMock({ scene: 'close', now, me }).engine
  const cs = close.stateView(now)
  const pct = Number((BigInt(cs.pile) * 100n) / BigInt(cs.target))
  assert.ok(pct >= 88 && pct < 100, `pile at ${pct} %`)
  assert.equal(cs.window_now, 3)
  assert.equal(close.holderView(me).wood, L.toUnits(120, 18).toString())
  assert.ok(close.historyView().length >= 30)
  assert.ok(close.recentView().some((t) => t.account === me))

  for (const [scene, outcome] of [['lit', 'LIT'], ['smoke', 'SMOKED'], ['cold', 'COLD']]) {
    const w = buildMock({ scene, now, me })
    const s = w.engine.stateView(now)
    assert.equal(s.due, true, scene + ' waits for settle')
    w.advance(now + 1000)
    assert.equal(w.engine.stateView(now + 1000).due, true, 'nobody settles it before the page')
    w.engine.catchUp(now + 1000)
    assert.equal(w.engine.nightView(s.night).outcome, outcome)
    const h = w.engine.holderView(me)
    if (outcome === 'LIT') assert.ok(BigInt(h.pending) > BigInt(h.wood), 'the player is owed its wood and a share')
    if (outcome === 'SMOKED') assert.ok(BigInt(h.pending) < BigInt(h.wood) && BigInt(h.pending) > 0n)
    conserved(w.engine)
  }
})

test('the icon is drawn as contract/src/icon.rs draws it', () => {
  const svg = drawIcon(4_600n, 4_000n, 'LIT', 3, ['LIT', 'SMOKED', 'COLD', 'LIT'])
  assert.ok(svg.startsWith("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>"))
  assert.ok(svg.includes(">LIT ×3</text>"))
  assert.ok(svg.includes("font-size='9'"), 'the word grows with the streak')
  // 115 % of the target: 14 + 15 * 8 / 50 = 16 px tall, tip at y 26
  assert.ok(svg.includes("<path d='M32 26C"), svg)
  assert.ok(svg.includes("<circle cx='17' cy='56' r='2.6' fill='#8f8c99'/>"), 'a smoke puff for night 2')
  assert.ok(svg.includes("<circle cx='24' cy='56' r='2' fill='none' stroke='#6c7a90'/>"), 'a ring for the cold night')
  assert.ok(drawIcon(0n, 4_000n, 'COLD', 0).includes('>COLD</text>'))
  const url = iconDataUrl(svg)
  assert.ok(url.startsWith('data:image/svg+xml,%3Csvg'))
  assert.ok(url.includes('%C3%97'), 'the multiplication sign is percent-encoded as UTF-8')
  assert.ok(/^[A-Za-z0-9\-_.!~*'()/:;=,%]+$/.test(url.slice('data:image/svg+xml,'.length)))
  assert.ok(L.safeIcon(url))
})
