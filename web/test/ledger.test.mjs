// The ledger: one row per settled night, every mint and burn, and the books in one line.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as L from '../js/logic.js'
import { ledgerCheckHtml, ledgerEventsHtml, ledgerHtml } from '../js/ui.js'
import { MockWorld } from '../js/mock.js'

const D = 18
const E = (n) => L.toUnits(n, D)
const row = (night, outcome, minted = 0, burned = 0, supply = 1_000_000) => ({ night, outcome, target: E(400).toString(), pile: E(outcome === 'COLD' ? 0 : 420).toString(), minted: E(minted).toString(), burned: E(burned).toString(), supply: E(supply).toString() })

test('fmtFixed keeps two decimals, rounds down, and signs', () => {
  assert.equal(L.fmtFixed(3_100_105_953_802_317_510_645_576n, D), '3,100,105.95')
  assert.equal(L.fmtFixed(E('0.5'), D), '0.50')
  assert.equal(L.fmtFixed(-E('1.239'), D), '-1.23')
  assert.equal(L.fmtFixed(1500n, 0), '1,500.00')
})

test('ledger rows: newest first, streak counted only where the run is known', () => {
  const rows = [row(5, 'LIT', 16), row(6, 'LIT', 17), row(7, 'SMOKED', 0, 12), row(8, 'LIT', 16), row(9, 'LIT', 17), row(10, 'COLD')]
  const r = L.ledgerRows(rows, new Map(), 1)
  assert.deepEqual(r.map((x) => x.night), [10, 9, 8, 7, 6, 5])
  // nights 5 and 6 may continue a run from before night 5: no count; 8 and 9 follow a smoked night
  assert.deepEqual(r.map((x) => x.word), ['COLD', 'LIT ×2', 'LIT ×1', 'SMOKED', 'LIT', 'LIT'])
  // from the first night on, the count is known
  assert.deepEqual(L.ledgerRows([row(1, 'LIT'), row(2, 'LIT')], new Map(), 1).map((x) => x.word), ['LIT ×2', 'LIT ×1'])
  assert.equal(L.ledgerRows([row(5, 'LIT')], new Map(), 5)[0].word, 'LIT ×1', 'the oldest night kept starts the count')
  assert.equal(r[0].hearthCut, null)
  assert.equal(r[3].burned, E(12))
})

test('ledger rows: night() splits the mint and the burn, and gives the exact streak', () => {
  const details = new Map([
    [5, { night: 5, outcome: 'LIT', streak: 9, hearth_cut: E('1.6').toString(), hearth_burned: '0' }],
    [7, { night: 7, outcome: 'SMOKED', streak: 0, hearth_cut: '0', hearth_burned: E(2).toString() }],
  ])
  const r = L.ledgerRows([row(5, 'LIT', 16), row(6, 'LIT', 17), row(7, 'SMOKED', 0, 12)], details, 1)
  const [smoked, , lit] = r
  assert.equal(lit.word, 'LIT ×9')
  assert.deepEqual([lit.shared, lit.hearthCut], [E('14.4'), E('1.6')])
  assert.deepEqual([smoked.pileBurn, smoked.hearthBurn], [E(10), E(2)])
})

test('the books: genesis + minted - burned = supply, and paging back through history', () => {
  const cfg = { genesis_supply: E(3_100_000).toString() }
  const ok = L.ledgerCheck(cfg, { supply: (E(3_100_000) + E('129.36') - E('23.41')).toString(), records: { total_minted: E('129.36').toString(), total_burned: E('23.41').toString() } })
  assert.equal(ok.ok, true)
  assert.equal(L.ledgerCheck(cfg, { supply: E(3_100_106).toString(), records: { total_minted: E('129.36').toString(), total_burned: E('23.41').toString() } }).ok, false)
  assert.deepEqual(L.olderPage(30, 12), { from: 18, limit: 12 })
  assert.deepEqual(L.olderPage(5, 12), { from: 1, limit: 4 })
  assert.deepEqual(L.olderPage(1, 12), { from: 1, limit: 0 })
  assert.deepEqual(L.mergeHistory([row(3, 'LIT'), row(4, 'COLD')], [row(4, 'COLD'), row(5, 'LIT')]).map((r) => r.night), [3, 4, 5])
})

test('ledger table: one row per night, explorer links only to the contract, no invented hashes', () => {
  const details = new Map([[2, { night: 2, outcome: 'LIT', streak: 2, hearth_cut: E('1.6').toString(), hearth_burned: '0' }]])
  const rows = L.ledgerRows([row(1, 'LIT', 16, 0, 1_000_016), row(2, 'LIT', 16, 0, 1_000_032), row(3, 'SMOKED', 0, 12, 1_000_020), row(4, 'COLD', 0, 0, 1_000_020)], details, 1)
  const html = ledgerHtml(rows, { decimals: D, explorer: 'https://testnet.nearblocks.io', contract: 'bonfire-coin.testnet', mock: false })
  assert.equal((html.match(/<tr class=/g) ?? []).length, 4)
  assert.match(html, /<td data-label="Night">4<\/td><td data-label="Outcome"><span class="tag cold">COLD<\/span>/)
  assert.match(html, /<span class="tag lit">LIT ×2<\/span>/)
  assert.match(html, /\+16\.00<small>14\.40 to throwers · 1\.60 to the hearth<\/small>/)
  assert.match(html, /−12\.00<\/td>/)
  assert.match(html, /1,000,020\.00/)
  const links = html.match(/href="[^"]+"/g)
  assert.equal(links.length, 4)
  assert.ok(links.every((l) => l === 'href="https://testnet.nearblocks.io/address/bonfire-coin.testnet"'), 'no tx links: history has no hashes')
  assert.ok(!/\/txns\//.test(html))
  const mock = ledgerHtml(rows, { decimals: D, explorer: 'x', contract: 'c', mock: true })
  assert.ok(!/href=/.test(mock), 'mock rows link nowhere')
  assert.match(ledgerHtml([], { decimals: D }), /No night has ended yet/)
})

test('the books line and the events line', () => {
  const c = { genesis: E(3_100_000), minted: E('129.36'), burned: E('23.41'), supply: E(3_100_000) + E('105.95'), ok: true }
  assert.match(ledgerCheckHtml(c, { decimals: D, symbol: 'EMBER' }), /3,100,000\.00 genesis \+ 129\.36 minted − 23\.41 burned = <b>3,100,105\.95<\/b>, the supply of EMBER now <span class="good">✓/)
  assert.match(ledgerCheckHtml({ ...c, supply: E(1), ok: false }, { decimals: D, symbol: 'EMBER' }), /the books do not add up/)
  const ev = ledgerEventsHtml({ explorer: 'https://testnet.nearblocks.io', contract: 'bonfire-coin.testnet', mock: false })
  assert.match(ev, /<code>ft_mint<\/code> with memo <code>night N lit<\/code>, <code>ft_burn<\/code>/)
  assert.match(ev, /href="https:\/\/testnet\.nearblocks\.io\/token\/bonfire-coin\.testnet"/)
  assert.ok(!/href/.test(ledgerEventsHtml({ explorer: 'x', contract: 'c', mock: true })))
})

test('in a month of mock play the ledger rows add up to the supply', () => {
  const w = new MockWorld({ nightMs: 300_000, genesisMs: 1_000_000, seed: 5 })
  w.advance(1_000_000 + 40 * 300_000 + 5)
  const e = w.engine
  const hist = e.historyView(1, 500)
  let net = 0n
  for (const r of hist) net += BigInt(r.minted) - BigInt(r.burned)
  assert.equal(e.genesisSupply + net, e.supply)
  assert.equal(L.ledgerCheck({ genesis_supply: e.genesisSupply.toString() }, e.stateView(1_000_000 + 40 * 300_000 + 5)).ok, true)
  const rows = L.ledgerRows(hist, new Map(), 1)
  assert.equal(rows.length, hist.length)
  assert.equal(rows[0].supply, e.supply)
})
