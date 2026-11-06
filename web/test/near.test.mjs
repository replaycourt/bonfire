import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import * as N from '../js/near.js'
import { ActionQueue, Client, GasPool, loadOrCreateIdentity, notDeployed } from '../js/chain.js'
import { throwAction } from '../js/logic.js'

const spki = (pub) => crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]), format: 'der', type: 'spki' })
const keyStr = (k) => 'ed25519:' + N.b58encode(N.concat(k.seed, k.publicKey))

test('base58 round-trips, keeps leading zeros and refuses bad characters', () => {
  const bytes = new Uint8Array([0, 0, 7, 255, 1, 2, 3, 128])
  assert.deepEqual([...N.b58decode(N.b58encode(bytes))], [...bytes])
  assert.equal(N.b58encode(new Uint8Array([0, 0, 1])), '112')
  assert.equal(N.b58encode(new Uint8Array(32)), '1'.repeat(32))
  assert.throws(() => N.b58decode('0OIl'))
})

test('hex and base64 helpers', () => {
  assert.equal(N.hex(new Uint8Array([0, 15, 255])), '000fff')
  assert.deepEqual([...N.unhex('000fff')], [0, 15, 255])
  const b = new Uint8Array([1, 2, 3, 250])
  assert.deepEqual([...N.unbase64(N.base64(b))], [...b])
})

test('WebCrypto Ed25519: new key, rebuild from seed, sign, verify, implicit account', async () => {
  assert.ok(await N.ed25519Supported())
  const k = await N.newKey()
  assert.equal(k.seed.length, 32)
  assert.equal(k.publicKey.length, 32)
  const msg = N.utf8('bonfire:v1:bonfire-coin.testnet:1:{"claim_kindling":{"night":1}}')
  const sig = await N.sign(k, msg)
  assert.equal(sig.length, 64)
  assert.ok(crypto.verify(null, msg, spki(k.publicKey), sig))
  const again = await N.keyFromSeed(k.seed, k.publicKey)
  assert.ok(crypto.verify(null, msg, spki(k.publicKey), await N.sign(again, msg)))
  assert.match(N.implicitAccount(k), /^[0-9a-f]{64}$/)
  assert.equal(N.implicitAccount(k), Buffer.from(k.publicKey).toString('hex'))
  assert.equal(N.nearPublicKey(k), 'ed25519:' + N.b58encode(k.publicKey))
})

test('keyFromNearString reads the seed and public key of a NEAR key string', async () => {
  const k = await N.newKey()
  const back = await N.keyFromNearString(keyStr(k))
  assert.deepEqual([...back.publicKey], [...k.publicKey])
  assert.equal((await N.sign(back, N.utf8('x'))).length, 64)
})

test('borsh transaction encoding has the expected layout', () => {
  const pk = new Uint8Array(32).fill(7)
  const action = N.functionCallAction({ method: 'act', args: { a: 1 }, gas: 100_000_000_000_000n, deposit: 0n })
  assert.equal(action[0], 2)
  assert.deepEqual([...action.slice(1, 5)], [3, 0, 0, 0])
  assert.equal(new TextDecoder().decode(action.slice(5, 8)), 'act')
  assert.equal(new DataView(action.buffer).getUint32(8, true), 7)
  assert.equal(action.length, 1 + 4 + 3 + 4 + 7 + 8 + 16)
  const tx = N.encodeTx({ signerId: 'g.testnet', publicKey: pk, nonce: 5n, receiverId: 'c.testnet', blockHash: new Uint8Array(32), actions: [action] })
  assert.equal(tx.length, 4 + 9 + 1 + 32 + 8 + 4 + 9 + 32 + 4 + action.length)
  assert.equal(tx[4 + 9], 0, 'key type ed25519')
  assert.equal(tx[4 + 9 + 1 + 32], 5, 'nonce little-endian')
})

test('signTx appends a signature over the sha256 of the transaction; txHash is its base58', async () => {
  const k = await N.newKey()
  const tx = N.encodeTx({ signerId: 'g.testnet', publicKey: k.publicKey, nonce: 1n, receiverId: 'c.testnet', blockHash: new Uint8Array(32), actions: [] })
  const signed = N.unbase64(await N.signTx(k, tx))
  assert.equal(signed.length, tx.length + 1 + 64)
  const digest = crypto.createHash('sha256').update(tx).digest()
  assert.ok(crypto.verify(null, digest, spki(k.publicKey), signed.slice(tx.length + 1)))
  assert.equal(await N.txHash(tx), N.b58encode(digest))
})

test('summarise reads SuccessValue and sums gas', () => {
  const res = {
    transaction: { hash: 'H' },
    transaction_outcome: { outcome: { gas_burnt: 1 } },
    receipts_outcome: [{ outcome: { gas_burnt: 2, logs: [] } }],
    status: { SuccessValue: Buffer.from('{"settled":1}').toString('base64') },
  }
  const s = N.summarise(res)
  assert.equal(s.hash, 'H')
  assert.equal(s.gas, 3)
  assert.deepEqual(s.value, { settled: 1 })
  assert.equal(s.failure, null)
  assert.ok(N.summarise({ ...res, status: { Failure: { x: 1 } } }).failure)
})

test('RpcError classifies NEAR errors; notDeployed spots a missing contract', () => {
  assert.ok(new N.RpcError('x', { cause: { name: 'TIMEOUT_ERROR' } }).transient)
  assert.ok(new N.RpcError('x', { data: { InvalidNonce: {} } }).invalidNonce)
  assert.ok(new N.RpcError('x', { data: 'NotEnoughAllowance' }).noAllowance)
  assert.ok(new N.RpcError('x', { data: 'Expired' }).expired)
  assert.ok(new N.RpcError('http 408', { http: 408, text: 'http 408' }).transient)
  assert.ok(!new N.RpcError('x', { data: 'something else' }).transient)
  assert.ok(notDeployed(new N.RpcError('x', { cause: { name: 'UNKNOWN_ACCOUNT' } })))
  assert.ok(notDeployed(new N.RpcError('x', { data: 'CodeDoesNotExist' })))
  assert.ok(!notDeployed(new Error('Failed to fetch')))
})

function fakeRpc(script) {
  const calls = []
  return {
    calls,
    fetch: async (host, { body }) => {
      const req = JSON.parse(body)
      calls.push({ method: req.method, params: req.params })
      const next = script[req.method]?.shift()
      if (next instanceof Error) throw next
      return { ok: true, status: 200, json: async () => next ?? { error: { name: 'NO_SCRIPT', method: req.method } } }
    },
  }
}
const methods = (f) => f.calls.map((c) => c.method)

test('Rpc falls over to the fallback host on network failure', async () => {
  const f = fakeRpc({ block: [new TypeError('Failed to fetch'), { result: { header: { hash: '11111111111111111111111111111111' } } }] })
  const rpc = new N.Rpc(['https://a', 'https://b'], { fetchImpl: f.fetch })
  let switched = null
  rpc.onHostChange = (h) => (switched = h)
  assert.equal((await rpc.blockHash()).length, 32)
  assert.equal(switched, 'https://b')
  assert.equal(rpc.host, 'https://b')
})

test('Rpc view decodes the result bytes; access keys and the account come from queries', async () => {
  const bytes = [...Buffer.from(JSON.stringify({ night: 3 }))]
  const f = fakeRpc({ query: [{ result: { result: bytes } }, { result: { keys: [] } }, { result: { code_hash: 'H' } }] })
  const rpc = new N.Rpc(['https://a'], { fetchImpl: f.fetch })
  assert.deepEqual(await rpc.view('c', 'state'), { night: 3 })
  assert.deepEqual(await rpc.accessKeyList('c'), [])
  assert.equal(f.calls[1].params.request_type, 'view_access_key_list')
  assert.equal((await rpc.viewAccount('c')).code_hash, 'H')
})

const okTx = (hash) => ({ result: { transaction: { hash }, transaction_outcome: { outcome: { gas_burnt: 1 } }, receipts_outcome: [], status: { SuccessValue: '' } } })
const blocks = (n) => Array.from({ length: n }, () => ({ result: { header: { hash: '11111111111111111111111111111111' } } }))

test('GasPool retires a key without allowance and re-reads a nonce on InvalidNonce', async () => {
  const k1 = await N.newKey()
  const k2 = await N.newKey()
  const f = fakeRpc({
    query: [{ result: { nonce: 10 } }, { result: { nonce: 20 } }, { result: { nonce: 30 } }],
    block: blocks(6),
    send_tx: [{ error: { data: 'NotEnoughAllowance' } }, { error: { data: { InvalidNonce: {} } } }, okTx('T')],
  })
  const rpc = new N.Rpc(['https://a'], { fetchImpl: f.fetch })
  const pool = new GasPool(rpc, [{ public_key: N.nearPublicKey(k1), private_key: keyStr(k1) }, { public_key: N.nearPublicKey(k2), private_key: keyStr(k2) }], 'gas.testnet')
  pool.cursor = 0
  const r = await pool.relay('c.testnet', 'settle', {}, 1n)
  assert.equal(r.hash, 'T')
  assert.equal(pool.alive().length, 1)
  assert.equal(methods(f).filter((m) => m === 'send_tx').length, 3)
})

test('GasPool looks a timed-out transaction up by hash instead of sending it twice', async () => {
  const k1 = await N.newKey()
  const f = fakeRpc({
    query: [{ result: { nonce: 10 } }],
    block: blocks(1),
    send_tx: [{ error: { name: 'REQUEST_TIMEOUT', cause: { name: 'TIMEOUT_ERROR' } } }],
    tx: [{ error: { cause: { name: 'UNKNOWN_TRANSACTION' } } }, okTx('T2')],
  })
  const rpc = new N.Rpc(['https://a'], { fetchImpl: f.fetch })
  const pool = new GasPool(rpc, [{ public_key: N.nearPublicKey(k1), private_key: keyStr(k1) }], 'gas.testnet')
  const r = await pool.relay('c.testnet', 'act', {}, 1n)
  assert.equal(r.hash, 'T2')
  assert.equal(methods(f).filter((m) => m === 'send_tx').length, 1, 'sent once')
  assert.equal(methods(f).filter((m) => m === 'tx').length, 2)
})

test('an empty gas pool says so instead of sending anything', async () => {
  const f = fakeRpc({})
  const pool = new GasPool(new N.Rpc(['https://a'], { fetchImpl: f.fetch }), [], 'gas.testnet')
  assert.ok(pool.empty)
  await assert.rejects(pool.relay('c', 'act', {}, 1n), /gas pool is empty/)
  assert.equal(f.calls.length, 0)
})

test('Client.act signs bonfire:v1:<contract>:<nonce>:<action> with the player key', async () => {
  const id = { key: await N.newKey() }
  id.account = N.implicitAccount(id.key)
  const relayed = []
  const pool = { empty: false, relay: async (receiver, method, args) => (relayed.push({ receiver, method, args }), { hash: 'H', gas: 5, failure: null, value: { ok: true, nonce: args.nonce } }) }
  const rpc = { view: async () => ({ nonce: 41 }) }
  const c = new Client({ rpc, contract: 'bonfire-coin.testnet', pool })
  await c.setIdentity(id)
  const action = throwAction(5n, 12)
  const out = await c.act(action)
  assert.equal(out.ok, true)
  const { receiver, method, args } = relayed[0]
  assert.equal(receiver, 'bonfire-coin.testnet')
  assert.equal(method, 'act')
  assert.equal(args.player_pubkey, id.account)
  assert.equal(args.action, action)
  assert.ok(args.nonce > 41)
  const text = `bonfire:v1:bonfire-coin.testnet:${args.nonce}:${action}`
  assert.ok(crypto.verify(null, Buffer.from(text), spki(id.key.publicKey), Buffer.from(args.signature, 'hex')))
  assert.equal(c.txs[0].hash, 'H')
})

test('ActionQueue keeps one act in flight and merges throws for the same night', async () => {
  const sent = []
  const fake = {
    act: async (action) => {
      sent.push(action)
      await new Promise((r) => setTimeout(r, 20))
      return { ok: true }
    },
  }
  const done = []
  const q = new ActionQueue(fake, { onDone: (out, item) => done.push(item.amount) })
  const item = (amount, night) => ({ kind: 'throw', amount, night, build() { return throwAction(this.amount, this.night) } })
  q.push(item(5n, 3))
  q.push(item(10n, 3))
  q.push(item(20n, 3))
  assert.equal(q.pendingWood(), 35n)
  q.push(item(1n, 4))
  await new Promise((r) => setTimeout(r, 120))
  assert.deepEqual(sent, [throwAction(5n, 3), throwAction(30n, 3), throwAction(1n, 4)])
  assert.deepEqual(done, [5n, 30n, 1n])
  assert.equal(q.busy, false)
})

test('ActionQueue reports errors and goes on', async () => {
  const fake = { act: async () => { throw new Error('boom') } }
  const errors = []
  const q = new ActionQueue(fake, { onError: (e) => errors.push(e.message) })
  q.push({ kind: 'kindling', build: () => '{}' })
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(errors, ['boom'])
  assert.equal(q.busy, false)
})

test('identity is created once and loaded again from storage', async () => {
  const store = new Map()
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
  const a = await loadOrCreateIdentity(storage)
  assert.ok(a.fresh)
  const b = await loadOrCreateIdentity(storage)
  assert.ok(!b.fresh)
  assert.equal(a.account, b.account)
  assert.deepEqual([...(await N.sign(a.key, N.utf8('m')))], [...(await N.sign(b.key, N.utf8('m')))])
  assert.ok(store.has('bonfire:key:v1'))
})

test('Client.collect relays collect for any account; estimate and recent_throws are views', async () => {
  const relayed = []
  const pool = { empty: false, relay: async (receiver, method, args, gas) => (relayed.push({ receiver, method, args, gas }), { hash: 'C', gas: 1, failure: null, value: { amount: '5' } }) }
  const views = []
  const rpc = { view: async (contract, method, args) => (views.push({ contract, method, args }), []) }
  const c = new Client({ rpc, contract: 'bonfire-stage.testnet', pool })
  assert.deepEqual(await c.collect('someone.testnet'), { amount: '5' })
  assert.deepEqual(relayed[0], { receiver: 'bonfire-stage.testnet', method: 'collect', args: { account_id: 'someone.testnet' }, gas: 30_000_000_000_000n })
  assert.equal(c.txs[0].kind, 'collect')
  await c.estimate(5n)
  await c.recentThrows()
  assert.deepEqual(views.map((v) => [v.method, v.args]), [['estimate', { amount: '5' }], ['recent_throws', undefined]])
})
