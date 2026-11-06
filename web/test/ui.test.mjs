// The "How it works" text, built from config() alone (no DOM needed for it).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { howHtml } from '../js/ui.js'

const E = (n) => (BigInt(n) * 10n ** 18n).toString()
const cfg = (over = {}) => ({
  config: { symbol: 'EMBER', decimals: 18, night_ms: 300_000, mint_bp: 400, hearth_cut_bp: 1000, grow_bp: 700, smoke_bp: 300, hearth_burn_bp: 25, shrink_bp: 1000, early_max_bp: 40_000, late_lit_bp: 2_500, pool_windows: 4, kindling: E(200), kindling_per_night: 1, ...over },
})

test('how it works: the numbers come from config()', () => {
  const html = howHtml(cfg())
  assert.match(html, /A night lasts 5 minutes/)
  assert.match(html, /4 % of the target is minted as new EMBER: 90 % to the throwers by weight/)
  assert.match(html, /Wood counts ×4 on an empty pile, falling to ×1 at the target, and ×0.25 above it/)
  assert.match(html, /The night has 4 quarters/)
})

test('how it works: kindling says how many claims a night, in words a newcomer reads right', () => {
  assert.match(howHtml(cfg()), /A newcomer gets 200 EMBER from the hearth, once\. The hearth pays one claim a night, first come, first served\./)
  assert.match(howHtml(cfg({ kindling: E(250), kindling_per_night: 10 })), /A newcomer gets 250 EMBER from the hearth, once\. The hearth pays 10 claims a night/)
  assert.ok(!/1 per night/.test(howHtml(cfg())))
})

const proof = (over = {}) => ({ mock: false, deployment: 'stage', contract: 'bonfire-stage.testnet', keys: [], codeHash: null, expectedHash: null, account: 'ab'.repeat(32), gasAccount: 'bonfire-gas.testnet', rpcHost: 'https://test.rpc.fastnear.com', txs: [], explorer: 'https://testnet.nearblocks.io', deployed: true, owed: { amount: '0', nights: 0 }, ...over })

test('proof: the deployed code hash is checked against the one the page expects', async () => {
  const { proofHtml } = await import('../js/ui.js')
  const H = 'EWcaLXmKxqtKqWGRE1NAnZQTq7i2q87JVUkhYi39mg5z'
  assert.match(proofHtml(proof({ keys: null })), /Code hash<\/span><span><span class="muted">checking…/)
  assert.match(proofHtml(proof({ codeHash: H, expectedHash: H })), new RegExp(`<code>${H}</code> <span class="good">· matches the build in the repository`))
  const other = proofHtml(proof({ codeHash: '11111111111111111111111111111111', expectedHash: H }))
  assert.match(other, /class="bad">· not the build this page expects \(EWca/)
  assert.ok(!/matches/.test(proofHtml(proof({ codeHash: H }))), 'no claim without an expected hash')
})

test('proof: what settled nights still owe, in words, also when it is nothing', async () => {
  const { proofHtml } = await import('../js/ui.js')
  assert.match(proofHtml(proof()), /Owed<\/span><span>nothing <span class="muted">· every thrower of a settled night has collected/)
  assert.match(proofHtml(proof({ owed: { amount: '24.25', nights: 1 } })), /24\.25 EMBER <span class="muted">to throwers of 1 settled night, until they collect/)
  assert.match(proofHtml(proof({ owed: { amount: '80', nights: 3 } })), /of 3 settled nights/)
})

test('proof: long values sit in a cell that may wrap (no row runs out of the drawer)', async () => {
  const { proofHtml } = await import('../js/ui.js')
  const html = proofHtml(proof({ codeHash: 'H' }))
  for (const li of html.match(/<li><span>[^<]+<\/span>.*?<\/li>/g)) assert.match(li, /^<li><span>[^<]+<\/span><(span|code)[ >]/, li.slice(0, 80))
  const { readFileSync } = await import('node:fs')
  const css = readFileSync(new URL('../css/style.css', import.meta.url), 'utf8')
  assert.match(css, /\.proof-list li > :last-child \{ min-width: 0; overflow-wrap: anywhere; \}/)
})
