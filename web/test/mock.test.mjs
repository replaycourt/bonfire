// The mock engine must behave like the contract, or the page would be tuned to a fantasy.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as L from '../js/logic.js'
import { MockEngine, MockWorld, buildMock, drawIcon, iconDataUrl, mockConfig } from '../js/mock.js'

const D = 18
const E = (n) => L.toUnits(n, D)
const NIGHT = 300_000
const G = 1_000_000

function engine(over = {}) {
  const cfg = { ...mockConfig(NIGHT), ...over }
  return new MockEngine(cfg, [
    { account_id: 'a.testnet', amount: E(10_000) },
    { account_id: 'b.testnet', amount: E(10_000) },
  ], G)
}

test('a lit night returns all wood and shares the mint by weight', () => {
  const e = engine()
  // a throws 3000 at the start (x6), b throws 1500 half way: 1000 below the target (x3.5), 500 above (x0.1)
  assert.ok(e.throw('a.testnet', E(3000), G).ok)
  assert.ok(e.throw('b.testnet', E(1500), G + NIGHT / 2).ok)
  const wa = E(3000) * 60_000n
  const wb = E(1000) * 35_000n + E(500) * 1000n
  assert.equal(e.weight, wa + wb)
  e.catchUp(G + NIGHT)
  const log = e.nightView(1)
  assert.equal(log.outcome, 'lit')
  const pool = E(200) - E(40)
  const ra = (pool * wa) / (wa + wb)
  const rb = (pool * wb) / (wa + wb)
  assert.equal(log.throwers[0].reward, ra.toString())
  assert.equal(log.throwers[1].reward, rb.toString())
  assert.equal(e.holderView('a.testnet').balance, (E(10_000) + ra).toString())
  assert.equal(e.target, E(4000) + E(280))
  assert.equal(e.streak, 1)
  assert.equal(e.hearth, E(400_000) + E(40))
  assert.ok(e.audit().balanced && e.audit().ledger)
})

test('a smoky night burns a share of the pile and of the hearth, and shrinks the target', () => {
  const e = engine()
  e.throw('a.testnet', E(1000), G)
  e.catchUp(G + NIGHT)
  const log = e.nightView(1)
  assert.equal(log.outcome, 'smoke')
  assert.equal(log.throwers[0].lost, E(10).toString())
  assert.equal(log.hearth_burned, ((E(400_000) * 10n) / 10_000n).toString())
  assert.equal(e.target, E(3600))
  assert.equal(e.streak, 0)
  assert.ok(e.audit().balanced && e.audit().ledger)
})

test('empty nights settle in a batch and the target stops at its floor', () => {
  const e = engine()
  e.catchUp(G + 40 * NIGHT)
  assert.equal(e.night, 31, 'max_catchup nights per call')
  assert.equal(e.records.nights_empty, 30)
  assert.equal(e.target, E(1000))
  assert.ok(e.audit().ledger)
})

test('throws are refused while ended nights wait, for unknown accounts and beyond the balance', () => {
  const e = engine()
  assert.match(e.throw('a.testnet', E(1), G + NIGHT).error, /settle/)
  assert.match(e.throw('x.testnet', E(1), G).error, /not registered/)
  assert.match(e.throw('a.testnet', E(20_000), G).error, /not enough/)
})

test('kindling: once per account, capped per night, only for accounts that never held EMBER', () => {
  const e = engine()
  for (let i = 0; i < 5; i++) assert.ok(e.claimKindling('k' + i, G).ok)
  assert.match(e.claimKindling('k9', G).error, /handed out/)
  assert.ok(e.claimKindling('k9', G + NIGHT).ok, 'a new night, new kindling')
  assert.match(e.claimKindling('k0', G + NIGHT).error, /never held/)
  assert.match(e.claimKindling('a.testnet', G + NIGHT).error, /never held/)
  assert.equal(e.stateView(G + NIGHT).kindling_left_tonight, 4)
  assert.equal(e.holderView('k9').may_take_kindling, false)
  assert.equal(e.holderView('fresh').may_take_kindling, true)
})

test('views are shaped like the contract JSON', () => {
  const e = engine()
  e.throw('a.testnet', E(100), G + 10)
  const s = e.stateView(G + 1000)
  for (const k of ['target', 'pile', 'weight', 'hearth', 'supply']) assert.equal(typeof s[k], 'string', k)
  assert.equal(s.clock_night, 1)
  assert.equal(s.throwers, 1)
  assert.equal(e.nightView(1).outcome, 'open')
  assert.equal(e.nightView(1).throwers[0].wood, E(100).toString())
  e.catchUp(G + NIGHT)
  const h = e.historyView()
  assert.equal(h.length, 1)
  assert.equal(h[0].outcome, 'smoke')
  assert.equal(typeof h[0].supply, 'string')
})

test('a month of scheduled play keeps every EMBER accounted for and mixes lit and smoky nights', () => {
  const w = new MockWorld({ nightMs: NIGHT, genesisMs: G, seed: 3 })
  w.advance(G + 60 * NIGHT + 5)
  const e = w.engine
  assert.ok(e.night >= 55, `night ${e.night}`)
  const a = e.audit()
  assert.ok(a.balanced, 'supply = balances + pile + hearth')
  assert.ok(a.ledger, 'supply = genesis + minted - burned')
  assert.ok(e.records.nights_lit > 10, `lit ${e.records.nights_lit}`)
  assert.ok(e.records.nights_smoke + e.records.nights_empty > 3, `smoke ${e.records.nights_smoke}`)
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
  assert.equal(close.holderView(me).wood, E(800).toString())
  assert.ok(close.historyView().length >= 30)

  for (const [scene, outcome] of [['lit', 'lit'], ['smoke', 'smoke']]) {
    const w = buildMock({ scene, now, me })
    const s = w.engine.stateView(now)
    assert.equal(s.due, true, scene + ' waits for settle')
    w.advance(now + 1000)
    assert.equal(w.engine.stateView(now + 1000).due, true, 'nobody settles it before the page')
    w.engine.catchUp(now + 1000)
    const log = w.engine.nightView(s.night)
    assert.equal(log.outcome, outcome)
    const mine = log.throwers.find((t) => t.account === me)
    assert.ok(mine, 'the player threw')
    if (outcome === 'lit') assert.ok(BigInt(mine.reward) > 0n)
    else assert.ok(BigInt(mine.lost) > 0n)
    assert.ok(w.engine.audit().balanced)
  }
})

test('the icon is drawn as the contract draws it', () => {
  const svg = drawIcon(E(4600), E(4000), 'lit', 3)
  assert.ok(svg.startsWith("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>"))
  assert.ok(svg.includes('>3</text>'))
  // 115 % of the target: 24 + 15 * 10 / 50 = 27 px tall, tip at y 17
  assert.ok(svg.includes("<path d='M32 17C"), svg)
  const cold = drawIcon(0n, E(4000), 'empty', 0)
  assert.ok(cold.includes("fill='#8f8c99'") && cold.includes("<circle cx='25' cy='39' r='2'/>"))
  const url = iconDataUrl(svg)
  assert.ok(url.startsWith('data:image/svg+xml,%3Csvg'))
  assert.ok(/^[A-Za-z0-9\-_.!~*'()/:;=,%]+$/.test(url.slice('data:image/svg+xml,'.length)))
  assert.ok(L.safeIcon(url))
})
