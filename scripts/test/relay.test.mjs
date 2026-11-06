// Offline tests of the relay and the bots' command line: no network, fetch is replaced by a fake
// RPC node. Run: node --test scripts/test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Signer, b58encode, nearSecretKey, newKey, keyFromNearString } from '../near-lite.mjs'
import { Player, Relay } from '../bonfire-lib.mjs'
import { botsFromSecret, nightsForMinutes, parseArgs } from '../bots.mjs'

/** A fake RPC node: view_access_key answers `akNonce()`, send_tx answers `sendTx(nonce, publicKey)`. */
function fakeNode({ akNonce, sendTx }) {
  const sent = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const { method, params } = JSON.parse(init.body)
    const reply = (body) => ({ status: 200, json: async () => ({ jsonrpc: '2.0', id: '1', ...body }) })
    if (method === 'query' && params.request_type === 'view_access_key') return reply({ result: { nonce: akNonce(params.public_key), permission: 'FullAccess' } })
    if (method === 'block') return reply({ result: { header: { hash: b58encode(Buffer.alloc(32, 7)) } } })
    if (method === 'send_tx') {
      const tx = Buffer.from(params.signed_tx_base64, 'base64')
      const signerLen = tx.readUInt32LE(0)
      const publicKey = 'ed25519:' + b58encode(tx.subarray(4 + signerLen + 1, 4 + signerLen + 33))
      const nonce = Number(tx.readBigUInt64LE(4 + signerLen + 33))
      sent.push({ nonce, publicKey })
      return reply(sendTx(nonce, publicKey, sent.length))
    }
    throw new Error(`unexpected ${method}`)
  }
  return { sent, restore: () => (globalThis.fetch = real) }
}

const ok = (n) => ({
  result: {
    transaction: { hash: `tx${n}` },
    transaction_outcome: { outcome: { gas_burnt: 1, tokens_burnt: '0', logs: [] } },
    receipts_outcome: [{ outcome: { gas_burnt: 2, tokens_burnt: '0', logs: [] } }],
    status: { SuccessValue: '' },
  },
})
const invalidNonce = { error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION' }, data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: 1, ak_nonce: 9 } } } } } }

test('a nonce taken by the page: the signer reads the nonce afresh and retries once', async () => {
  let ak = 100
  const node = fakeNode({
    akNonce: () => ak,
    sendTx: (nonce, _, i) => {
      if (i === 1) {
        ak = 105 // the page used the key meanwhile
        return invalidNonce
      }
      return ok(i)
    },
  })
  try {
    const s = new Signer('gas.testnet', newKey(), { shared: true })
    const r = await s.call('c.testnet', 'settle', {})
    assert.equal(r.hash, 'tx2')
    assert.deepEqual(node.sent.map((x) => x.nonce), [101, 106])
  } finally {
    node.restore()
  }
})

test('a second clash on the same key is not retried by the signer', async () => {
  const node = fakeNode({ akNonce: () => 7, sendTx: () => invalidNonce })
  try {
    const s = new Signer('gas.testnet', newKey(), { shared: true })
    await assert.rejects(s.call('c.testnet', 'settle', {}), /InvalidNonce/)
    assert.equal(node.sent.length, 2)
  } finally {
    node.restore()
  }
})

test('the relay moves to another key when one key keeps clashing, and drops a key out of allowance', async () => {
  const keys = [newKey(), newKey(), newKey()]
  const pubs = keys.map((k) => 'ed25519:' + b58encode(k.publicKey))
  const node = fakeNode({
    akNonce: () => 1,
    sendTx: (_, pk) =>
      pk === pubs[0] ? invalidNonce : pk === pubs[1] ? { error: { name: 'HANDLER_ERROR', data: { InvalidTxError: { NotEnoughAllowance: {} } } } } : ok(0),
  })
  try {
    const relay = new Relay('c.testnet', { keys: keys.map((k) => ({ account: 'gas.testnet', private_key: nearSecretKey(k) })) })
    const r = await relay.call('settle', {}, { slot: 0 })
    assert.equal(r.hash, 'tx0')
    assert.equal(node.sent.at(-1).publicKey, pubs[2])
    for (let i = 0; i < 20; i++) assert.equal((await relay.call('settle', {})).hash, 'tx0')
    // The key out of allowance was tried at most once, then dropped for good.
    assert.ok(node.sent.filter((x) => x.publicKey === pubs[1]).length <= 1)
  } finally {
    node.restore()
  }
})

test('act nonces are time-based and always rise', async () => {
  const p = Player.fresh('t')
  p.nonce = 5
  const a = await p.signed('c.testnet', { collect: { night: 1 } })
  const b = await p.signed('c.testnet', { collect: { night: 1 } })
  assert.ok(a.nonce >= Date.now() - 5_000 && b.nonce > a.nonce && b.nonce <= Number.MAX_SAFE_INTEGER)
  p.nonce = Number.MAX_SAFE_INTEGER - 10 // a nonce from the future still rises by one
  assert.equal((await p.signed('c.testnet', { collect: { night: 1 } })).nonce, Number.MAX_SAFE_INTEGER - 9)
})

test('the secret BONFIRE_BOTS: hex seeds of labelled bots only, and no seed in any message', () => {
  const a = Player.fresh('a')
  const b = Player.fresh('b')
  const deployments = { x: { contract: 'x.testnet', bots: { [a.account]: 'demo-bot-early-a', [b.account]: 'demo-bot-idle' } } }
  const bots = botsFromSecret(JSON.stringify([a.seedHex, b.seedHex, a.seedHex]), 'x.testnet', deployments)
  assert.deepEqual(bots.map((x) => x.label), ['demo-bot-early-a', 'demo-bot-idle'])
  assert.deepEqual(bots.map((x) => x.account), [a.account, b.account])
  const stranger = Player.fresh('s')
  for (const [text, re] of [
    ['not json', /not valid JSON/],
    ['[]', /non-empty/],
    ['["abc"]', /not a 64-character hex seed/],
    [JSON.stringify([stranger.seedHex]), /does not label/],
  ]) {
    assert.throws(() => botsFromSecret(text, 'x.testnet', deployments), (e) => re.test(e.message) && !e.message.includes(stranger.seedHex))
  }
})

test('the command line: one of --nights and --minutes, bounded', () => {
  assert.equal(parseArgs(['c.testnet', '--minutes', '350']).minutes, 350)
  assert.throws(() => parseArgs(['c.testnet', '--minutes', '351']), /1 to 350/)
  assert.throws(() => parseArgs(['c.testnet', '--minutes', '10', '--nights', '2']), /exactly one/)
  assert.throws(() => parseArgs(['c.testnet']), /exactly one/)
  assert.equal(parseArgs(['c.testnet', '--dry-run']).dryRun, true)
  assert.equal(nightsForMinutes(350, 300_000), 68) // 68 nights, a night of waiting and a minute to finish: under 350 minutes
  assert.equal(nightsForMinutes(5, 300_000), 1)
})

test('keys round-trip through their NEAR string form', () => {
  const k = newKey()
  assert.deepEqual(keyFromNearString(nearSecretKey(k)).publicKey, k.publicKey)
})
