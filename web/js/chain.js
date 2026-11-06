// Talks to the Bonfire contract: the player's local key, the public gas pool, the views, `act` and
// `settle`, with retries over keys and RPC hosts. The UI never sees a transaction; it sees promises
// that resolve to outcomes, and friendly errors when the network is in a mood.
// (The gas pool and the retry logic are taken over from Lantern Row, an earlier game by the same author.)
import { Rpc, RpcError, encodeTx, functionCallAction, hex, implicitAccount, keyFromNearString, keyFromSeed, newKey, sign, signTx, sleep, summarise, txHash, unhex, utf8 } from './near.js'
import { ACT_GAS, CONTRACT, GAS_ACCOUNT, GAS_KEYS, RPC_HOSTS, SETTLE_GAS } from './config.js'
import { nextNonce, signingText } from './logic.js'

const STORE_KEY = 'bonfire:key:v1'

export class FriendlyError extends Error {
  constructor(message, cause) {
    super(message)
    this.cause = cause
  }
}

// ---- the player's identity ----------------------------------------------------------------------

export async function loadOrCreateIdentity(storage = globalThis.localStorage, storeKey = STORE_KEY) {
  const raw = storage?.getItem(storeKey)
  if (raw) {
    try {
      const { seed, pub } = JSON.parse(raw)
      const key = await keyFromSeed(unhex(seed), unhex(pub))
      return { key, account: implicitAccount(key), fresh: false }
    } catch {
      // fall through and make a new one
    }
  }
  const key = await newKey()
  storage?.setItem(storeKey, JSON.stringify({ seed: hex(key.seed), pub: hex(key.publicKey) }))
  return { key, account: implicitAccount(key), fresh: true }
}

// ---- the gas pool -------------------------------------------------------------------------------

export class GasPool {
  constructor(rpc, keys = GAS_KEYS, account = GAS_ACCOUNT) {
    this.rpc = rpc
    this.account = account
    this.entries = keys.map((k) => ({ ...k, key: null, nonce: null, dead: false, busy: false }))
    this.cursor = Math.floor(Math.random() * Math.max(1, this.entries.length))
    this.lastKey = null
  }

  get empty() {
    return this.entries.length === 0
  }

  alive() {
    return this.entries.filter((e) => !e.dead)
  }

  pick() {
    const alive = this.alive()
    if (!alive.length) throw new FriendlyError('The gas pool is empty. The fire keeps burning; actions resume once the pool is refilled.')
    for (let i = 0; i < alive.length; i++) {
      const e = alive[(this.cursor + i) % alive.length]
      if (!e.busy) {
        this.cursor = (this.cursor + i + 1) % alive.length
        return e
      }
    }
    return alive[this.cursor++ % alive.length]
  }

  async ready(e) {
    if (!e.key) e.key = await keyFromNearString(e.private_key)
    if (e.nonce === null) e.nonce = await this.rpc.accessKeyNonce(this.account, e.public_key)
  }

  /** Sends one function call with a pool key, rotating keys on trouble. Returns summarise(result). */
  async relay(receiver, method, args, gas, { attempts = 5 } = {}) {
    let lastErr
    for (let attempt = 0; attempt < attempts; attempt++) {
      const e = this.pick()
      e.busy = true
      try {
        await this.ready(e)
        const blockHash = await this.rpc.blockHash()
        e.nonce += 1n
        const tx = encodeTx({ signerId: this.account, publicKey: e.key.publicKey, nonce: e.nonce, receiverId: receiver, blockHash, actions: [functionCallAction({ method, args, gas })] })
        const signed = await signTx(e.key, tx)
        const hash = await txHash(tx)
        const res = await this.send(signed, hash)
        this.lastKey = e.public_key
        return summarise(res)
      } catch (err) {
        lastErr = err
        if (err instanceof RpcError) {
          if (err.invalidNonce) e.nonce = null
          else if (err.noAllowance) e.dead = true
          else if (!err.expired && !err.transient) throw friendly(err)
        }
        await sleep(300 + attempt * 400)
      } finally {
        e.busy = false
      }
    }
    throw friendly(lastErr)
  }

  /**
   * Sends one signed transaction and gets its outcome, even when the RPC times out after the chain
   * already took it: a timeout is followed by asking for the status by hash; an unknown hash is sent
   * again, the same bytes, so nothing is ever applied twice.
   */
  async send(signed, hash) {
    let timedOut = null
    for (let round = 0; round < 2; round++) {
      try {
        return await this.rpc.sendTx(signed)
      } catch (err) {
        if (!(err instanceof RpcError) || !err.transient) {
          if (round > 0 && err instanceof RpcError && err.invalidNonce) {
            const found = await this.lookup(hash, 8)
            if (found) return found
          }
          throw err
        }
        timedOut = err
      }
      const found = await this.lookup(hash, 6)
      if (found) return found
    }
    throw timedOut
  }

  async lookup(hash, tries) {
    for (let i = 0; i < tries; i++) {
      await sleep(1200)
      const r = await this.rpc.txStatus(hash, this.account).catch(() => null)
      if (r?.status) return r
    }
    return null
  }
}

export function friendly(err) {
  if (err instanceof FriendlyError) return err
  const t = String(err?.message ?? err)
  console.info('chain', t.slice(0, 300))
  if (/InvalidNonce/.test(t)) return new FriendlyError('The relay was busy. Nothing was lost; try again.', err)
  if (/NotEnoughAllowance|AccessKeyDoesNotExist/.test(t)) return new FriendlyError('The gas pool is running low. Try again in a moment.', err)
  if (/TIMEOUT|timeout|Failed to fetch|NetworkError|http 5|abort/i.test(t)) return new FriendlyError('The network hiccupped. Nothing was lost; try again.', err)
  return new FriendlyError('Something went wrong on the way to the fire. Nothing was lost.', err)
}

/** True when an RPC error says the contract account or its code does not exist (not deployed yet). */
export function notDeployed(err) {
  const t = JSON.stringify(err?.detail ?? '') + String(err?.message ?? '')
  return /UNKNOWN_ACCOUNT|does not exist|CodeDoesNotExist|NO_CONTRACT_CODE|MethodNotFound/.test(t)
}

// ---- the contract -------------------------------------------------------------------------------

export class Client {
  constructor({ rpc = new Rpc(RPC_HOSTS), contract = CONTRACT, pool } = {}) {
    this.mock = false
    this.rpc = rpc
    this.contract = contract
    this.pool = pool ?? new GasPool(rpc)
    this.identity = null
    this.nonce = 0
    this.txs = [] // {kind, hash, gas, at, failure}
    this.onTx = null
  }

  get canAct() {
    return !this.pool.empty
  }

  view(method, args) {
    return this.rpc.view(this.contract, method, args)
  }
  config() {
    return this.view('config')
  }
  state() {
    return this.view('state')
  }
  holder(account = this.identity?.account) {
    return this.view('holder', { account_id: account })
  }
  night(n) {
    return this.view('night', { n })
  }
  history(from, limit) {
    return this.view('history', { from, limit })
  }
  ftMetadata() {
    return this.view('ft_metadata')
  }
  accessKeys() {
    return this.rpc.accessKeyList(this.contract)
  }
  viewAccount() {
    return this.rpc.viewAccount(this.contract)
  }

  async setIdentity(identity) {
    this.identity = identity
    const me = await this.holder()
    this.nonce = me.nonce ?? 0
    return me
  }

  record(kind, r) {
    const entry = { kind, hash: r.hash, gas: r.gas, at: Date.now(), failure: r.failure }
    this.txs.unshift(entry)
    this.txs = this.txs.slice(0, 40)
    this.onTx?.(entry)
    return entry
  }

  /** Signs one action (a JSON string) and relays it. Returns the ActOutcome; refusals come back in `error`. */
  async act(action) {
    if (!this.identity) throw new FriendlyError('No key yet.')
    for (let attempt = 0; attempt < 3; attempt++) {
      const nonce = nextNonce(this.nonce, Date.now())
      this.nonce = nonce
      const signature = hex(await sign(this.identity.key, utf8(signingText(this.contract, nonce, action))))
      let r
      try {
        r = await this.pool.relay(this.contract, 'act', { player_pubkey: this.identity.account, nonce, action, signature }, ACT_GAS)
      } catch (e) {
        await this.resync()
        throw e
      }
      this.record('act', r)
      if (r.failure) {
        if (/nonce/i.test(r.failure) && attempt < 2) {
          await this.resync()
          continue
        }
        throw new FriendlyError('The fire keeper refused that. Nothing was lost.', new Error(r.failure))
      }
      return r.value
    }
    throw new FriendlyError('The action could not be signed in. Try again.')
  }

  async resync() {
    try {
      const me = await this.holder()
      this.nonce = Math.max(this.nonce, me.nonce ?? 0)
    } catch {
      /* the next view will tell */
    }
  }

  async settle() {
    const r = await this.pool.relay(this.contract, 'settle', {}, SETTLE_GAS, { attempts: 3 })
    this.record('settle', r)
    if (r.failure) throw new FriendlyError('Dawn did not come through. Trying again shortly.', new Error(r.failure))
    return r.value
  }
}

// ---- the action queue ---------------------------------------------------------------------------

/**
 * One `act` in flight at a time, so nonces never overtake each other. Throws for the same night
 * that pile up while one is in flight are merged into one. `onDone(outcome, item)` and
 * `onError(err, item)` report back.
 */
export class ActionQueue {
  constructor(client, { onDone, onError, onChange } = {}) {
    this.client = client
    this.items = []
    this.inflight = null
    this.onDone = onDone
    this.onError = onError
    this.onChange = onChange
  }

  get busy() {
    return !!this.inflight || this.items.length > 0
  }

  /** Pending wood not yet confirmed, in base units. */
  pendingWood() {
    const all = [...this.items, ...(this.inflight ? [this.inflight] : [])]
    return all.filter((i) => i.kind === 'throw').reduce((s, i) => s + i.amount, 0n)
  }

  push(item) {
    const last = this.items[this.items.length - 1]
    if (item.kind === 'throw' && last?.kind === 'throw' && last.night === item.night) last.amount += item.amount
    else this.items.push(item)
    this.onChange?.()
    this.pump()
  }

  async pump() {
    if (this.inflight || !this.items.length) return
    const item = this.items.shift()
    this.inflight = item
    this.onChange?.()
    try {
      const out = await this.client.act(item.build())
      this.onDone?.(out, item)
    } catch (e) {
      this.onError?.(e, item)
    } finally {
      this.inflight = null
      this.onChange?.()
      this.pump()
    }
  }
}
