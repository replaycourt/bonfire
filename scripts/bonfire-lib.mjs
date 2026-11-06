// Shared pieces of the Bonfire testnet scripts: paths, the git-ignored secrets, the relay pool,
// browser-style players that sign `act`, and an independent model of the settlement arithmetic
// (written from DESIGN.md and contract/README.md, not from the contract's source).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Signer, assertTestnet, hex, implicitAccount, keyFromNearString, keyFromSeed, newKey, nearPublicKey, nearSecretKey, sign, view } from './near-lite.mjs'
import { DEPLOYMENTS } from '../web/js/config.js'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SECRETS = join(ROOT, '.secrets')
export const TGAS = 1_000_000_000_000n
export const EMBER = 10n ** 18n
export const BP = 10_000n

export const sleep = (ms) => new Promise((s) => setTimeout(s, ms))

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** Writes a secrets file readable by its owner only. */
export function writeSecret(name, data) {
  mkdirSync(SECRETS, { recursive: true, mode: 0o700 })
  const file = join(SECRETS, name)
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  chmodSync(file, 0o600)
  return file
}

export const botsFile = (contract) => join(SECRETS, `bots-${contract}.json`)
export const poolFile = (contract) => join(SECRETS, `gas-pool-${contract}.json`)

/** EMBER with up to 4 decimals, from base units. */
export function ember(x) {
  const v = BigInt(x)
  const sign = v < 0n ? '-' : ''
  const a = v < 0n ? -v : v
  const whole = a / EMBER
  const frac = ((a % EMBER) * 10_000n) / EMBER
  return `${sign}${whole.toLocaleString('en-US')}${frac ? '.' + String(frac).padStart(4, '0').replace(/0+$/, '') : ''}`
}

// ---- players: browser-style keys that sign `act` -------------------------------------------------

export class Player {
  constructor(label, key) {
    this.label = label
    this.key = key
    this.account = implicitAccount(key)
    this.nonce = null
  }

  static fromSecret(label, secret) {
    return new Player(label, keyFromNearString(secret))
  }

  static fresh(label) {
    return new Player(label, newKey())
  }

  static fromSeedHex(label, seedHex) {
    return new Player(label, keyFromSeed(Buffer.from(seedHex, 'hex')))
  }

  get seedHex() {
    return hex(this.key.seed)
  }

  get publicKey() {
    return nearPublicKey(this.key)
  }

  get secretKey() {
    return nearSecretKey(this.key)
  }

  /**
   * The signed `act` arguments for `action` (an object). The nonce is time-based, so it stays above
   * every earlier one across runs and machines: max(now in ms, last nonce + 1).
   */
  async signed(contract, action, nonce = null) {
    if (this.nonce === null) this.nonce = (await view(contract, 'holder', { account_id: this.account })).nonce
    const n = nonce ?? Math.max(Date.now(), this.nonce + 1)
    if (n > this.nonce) this.nonce = n
    const text = JSON.stringify(action)
    const message = `bonfire:v1:${contract}:${n}:${text}`
    return { player_pubkey: this.account, nonce: n, action: text, signature: hex(sign(this.key, Buffer.from(message, 'utf8'))) }
  }
}

export function loadBots(contract) {
  return readJson(botsFile(contract)).map((b) => Player.fromSecret(b.label, b.secret_key))
}

/** The NEP-297 events of a transaction: [{standard, event, data}]. */
export function parseEvents(logs) {
  return logs.filter((l) => l.startsWith('EVENT_JSON:')).map((l) => JSON.parse(l.slice('EVENT_JSON:'.length)))
}

/** The `bonfire throw` entry of a transaction, if it threw. */
export function throwEvent(r) {
  const e = parseEvents(r.logs ?? []).find((x) => x.standard === 'bonfire' && x.event === 'throw')
  return e ? e.data[0] : null
}

// ---- the relay: function-call keys of the gas account ---------------------------------------------

/**
 * The relay keys of `contract`: the git-ignored .secrets/gas-pool-<contract>.json if it exists, else
 * the public function-call keys the page uses (web/js/config.js). [{account, private_key}]
 */
export function relayKeys(contract) {
  if (existsSync(poolFile(contract))) return readJson(poolFile(contract)).filter((k) => k.contract === contract)
  const d = Object.values(DEPLOYMENTS).find((x) => x.contract === contract)
  return d ? d.gasKeys.map((k) => ({ account: d.gasAccount, private_key: k.private_key })) : []
}

export class Relay {
  /** The keys are shared with the page, so every transaction reads its key's nonce afresh. */
  constructor(contract, { keys } = {}) {
    assertTestnet(contract)
    this.contract = contract
    const pool = keys ?? relayKeys(contract)
    if (!pool.length) throw new Error(`no gas keys for ${contract} (neither .secrets/gas-pool-${contract}.json nor web/js/config.js)`)
    this.signers = pool.map((k) => new Signer(k.account, keyFromNearString(k.private_key), { shared: true }))
    this.dead = new Set()
  }

  /**
   * The key in `slot`, or a random live one not in `avoid`: spreading the load keeps clashes with
   * the page rare.
   */
  pick(slot, avoid = new Set()) {
    if (slot !== undefined) return this.signers[slot % this.signers.length]
    const live = this.signers.filter((s) => !this.dead.has(s))
    if (!live.length) throw new Error('every gas key is out of allowance or gone')
    const fresh = live.filter((s) => !avoid.has(s))
    const from = fresh.length ? fresh : live
    return from[Math.floor(Math.random() * from.length)]
  }

  /**
   * Calls `method` (act, settle or collect) through a gas key, 30 Tgas attached. A nonce clash the
   * key's own retry could not resolve moves to another key; a key out of allowance is dropped.
   */
  async call(method, args, { slot, gas = 30n * TGAS } = {}) {
    let last
    const tried = new Set()
    for (let attempt = 0; attempt < 3; attempt++) {
      const s = this.pick(attempt === 0 ? slot : undefined, tried)
      tried.add(s)
      try {
        return await s.call(this.contract, method, args, { gas })
      } catch (e) {
        last = e
        if (/NotEnoughAllowance|AccessKeyDoesNotExist/.test(e.message)) this.dead.add(s)
        else if (!/InvalidNonce/.test(e.message)) throw e
      }
    }
    throw last
  }

  async act(player, action, { slot, nonce } = {}) {
    const args = await player.signed(this.contract, action, nonce)
    const r = await this.call('act', args, { slot })
    return { ...r, args }
  }
}

// ---- the settlement arithmetic, from the written rules --------------------------------------------

const ceilDiv = (a, b) => (a + b - 1n) / b

/**
 * Weight of `below` units landing on a pile that already holds `before`: the reference formula of
 * DESIGN.md, `below * (em * 2T - (em - 1) * (2 * pile + below)) / 2T`, in basis points, rounded down.
 */
export function sliceWeight(target, em, before, below) {
  if (below === 0n) return 0n
  return (below * (em * 2n * target - (em - BP) * (2n * before + below))) / (2n * target)
}

/** [wood, weight] of each pooled window, in window order. */
export function windowWeights(windows, target, em, late) {
  let start = 0n
  return windows.map((x) => {
    const below = start >= target ? 0n : x < target - start ? x : target - start
    const w = sliceWeight(target, em, start, below) + (x - below) * late
    start += x
    return [x, w]
  })
}

export const bpOf = (x, bp) => (x * BigInt(bp)) / BP

/** What a settled night owes a thrower whose wood by window is `wood` ({window: amount}). */
export function creditOf(night, wood) {
  const total = Object.values(wood).reduce((a, b) => a + b, 0n)
  if (night.outcome === 'LIT') {
    let weight = 0n
    for (const [w, a] of Object.entries(wood)) {
      const [x, ws] = night.weights[Number(w)]
      weight += (ws * a) / x
    }
    return { amount: total + (night.weight > 0n ? (night.shared * weight) / night.weight : 0n), weight }
  }
  return { amount: (total * night.back) / night.pile, weight: 0n }
}

/**
 * Settles the open night of `m` (a model state) the way DESIGN.md says, and returns the night's
 * record. `m` holds target, pile, windows, hearth, supply, streak, records and the night number.
 */
export function settleNight(m, cfg) {
  const em = BigInt(cfg.early_max_bp)
  const late = BigInt(cfg.late_lit_bp)
  const n = m.night
  const target = m.target
  const pile = m.pile
  const rec = {
    night: n, target, pile, throwers: m.throwers.size, outcome: 'COLD', minted: 0n, hearth_cut: 0n,
    burned: 0n, hearth_burned: 0n, shared: 0n, back: 0n, weight: 0n, weights: [],
    firestarter: m.firestarter, last_log: m.lastLog, windows: [...m.windows], wood: new Map(m.throwers),
  }
  let rule
  if (pile > 0n && pile >= target) {
    rec.outcome = 'LIT'
    rec.weights = windowWeights(m.windows, target, em, late)
    rec.weight = rec.weights.reduce((a, [, w]) => a + w, 0n)
    rec.minted = bpOf(target, cfg.mint_bp)
    rec.hearth_cut = bpOf(rec.minted, cfg.hearth_cut_bp)
    rec.shared = rec.minted - rec.hearth_cut
    m.supply += rec.minted
    m.hearth += rec.hearth_cut
    m.streak += 1
    m.records.total_minted += rec.minted
    m.records.nights_lit += 1
    if (m.streak > m.records.longest_streak) m.records.longest_streak = m.streak
    if (target > m.records.tallest_fire) m.records.tallest_fire = target
    rule = (target * (BP + BigInt(cfg.grow_bp))) / BP
    rec.remaining = pile + rec.shared
  } else if (pile > 0n) {
    rec.outcome = 'SMOKED'
    const burn = bpOf(pile, cfg.smoke_bp)
    rec.back = pile - burn
    const hb = bpOf(m.hearth, cfg.hearth_burn_bp)
    const cap = bpOf(target, cfg.mint_bp)
    rec.hearth_burned = hb < cap ? hb : cap
    rec.burned = burn + rec.hearth_burned
    m.hearth -= rec.hearth_burned
    m.supply -= rec.burned
    m.streak = 0
    m.records.total_burned += rec.burned
    m.records.nights_smoked += 1
    rule = (target * (BP - BigInt(cfg.shrink_bp))) / BP
    rec.remaining = rec.back
  } else {
    m.streak = 0
    m.records.nights_cold += 1
    rule = (target * (BP - BigInt(cfg.shrink_bp))) / BP
    rec.remaining = 0n
  }
  // The pile of the settled night is owed to its throwers, so it counts as free supply.
  let next = rule
  if (cfg.target_cap_bp > 0) {
    const cap = bpOf(m.supply - m.hearth, cfg.target_cap_bp)
    if (cap < next) next = cap
  }
  const floor = BigInt(cfg.target_min)
  if (next < floor) next = floor
  rec.target_next = next
  rec.streak = m.streak
  rec.supply = m.supply
  rec.left = rec.throwers
  m.target = next
  m.pile = 0n
  m.windows = m.windows.map(() => 0n)
  m.throwers = new Map()
  m.firestarter = null
  m.lastLog = null
  m.owed += rec.remaining
  if (rec.throwers > 0) m.owedNights += 1
  m.night += 1
  return rec
}

/** The pooling window wood landing at `ms` falls in. */
export function windowAt(cfg, nightStartMs, ms) {
  const night = Number(cfg.night_ms)
  const e = Math.min(Math.max(ms - nightStartMs, 0), night - 1)
  return Math.floor((e * cfg.pool_windows) / night)
}
