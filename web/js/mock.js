// MOCK MODE, for development only: `?mock=1` in the URL. Never active otherwise.
//
// A copy of the contract's ritual in BigInt (pooled windows, pile-position weights, pull payments,
// the same rounding and the same views), the demo bots of sim/params.json and a few made-up players
// throwing on a schedule, and a client with the same methods as the real one. Nothing here touches
// the network. It exists so every state of the page can be seen without a deployment:
// `&scene=first|newcomer|early|close|late|collected|lit|smoke|cold|live`, `&night=<seconds>`.
import { BP, big, clockNight, hashSeed, windowAt, windowWeights } from './logic.js'

const DEC = 18
const E = (whole) => BigInt(Math.round(whole * 1000)) * 10n ** BigInt(DEC - 3)
const SUPPLY_CAP = 1n << 112n
const RECENT = 16
const ICON_NIGHTS = 7
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** The testnet launch values of sim/params.json, as `config().config` shows them. */
export function mockConfig(nightMs = 300_000) {
  return {
    name: 'Bonfire',
    symbol: 'EMBER',
    decimals: DEC,
    night_ms: nightMs,
    hearth_genesis: E(900_000).toString(),
    target_start: E(400).toString(),
    target_min: E(100).toString(),
    grow_bp: 700,
    shrink_bp: 1000,
    mint_bp: 400,
    hearth_cut_bp: 1000,
    smoke_bp: 300,
    hearth_burn_bp: 25,
    early_max_bp: 40_000,
    late_lit_bp: 2500,
    pool_windows: 4,
    target_cap_bp: 2500,
    min_throw: E(1).toString(),
    kindling: E(200).toString(),
    kindling_per_night: 1,
    max_catchup: 30,
    log_keep: 48,
    max_accounts: 4505,
    history_keep: 4096,
  }
}

export function rng(seed) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
}

const fakeHex = (r) => Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('')
const fakeHash = (r) => Array.from({ length: 44 }, () => B58[Math.floor(r() * 58)]).join('')
const s = (v) => v.toString()
const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0n)

// ---- the contract, in miniature -------------------------------------------------------------------

export class MockEngine {
  constructor(cfg, founders, genesisMs, contract = 'bonfire-stage.testnet') {
    this.cfg = cfg
    this.contract = contract
    this.genesisMs = genesisMs
    this.founders = founders
    this.holders = new Map()
    this.night = 1
    this.target = big(cfg.target_start)
    this.pile = 0n
    this.windows = Array(cfg.pool_windows).fill(0n)
    this.throwers = 0
    this.firestarter = null
    this.lastLog = null
    this.hearth = big(cfg.hearth_genesis)
    this.supply = this.hearth
    this.balances = 0n
    this.owed = 0n
    this.owedNights = 0
    this.owedByNight = new Map()
    this.streak = 0
    this.records = { longest_streak: 0, tallest_fire: 0n, total_minted: 0n, total_burned: 0n, nights_lit: 0, nights_smoked: 0, nights_cold: 0, kindling_claims: 0 }
    this.last = null
    this.kindlingNight = 1
    this.kindlingClaims = 0
    this.sponsored = 0
    this.logs = new Map()
    this.history = []
    this.recent = []
    for (const f of founders) {
      this.holders.set(f.account_id, { balance: big(f.amount), nonce: 0, sponsored: true, held: true, kindled: false, pending: null })
      this.balances += big(f.amount)
      this.supply += big(f.amount)
      this.sponsored++
    }
    this.genesisSupply = this.supply
  }

  clock(now) {
    return clockNight(now, this.genesisMs, this.cfg.night_ms)
  }
  start(n) {
    return this.genesisMs + (n - 1) * this.cfg.night_ms
  }
  end(n) {
    return this.genesisMs + n * this.cfg.night_ms
  }
  windowAt(elapsed) {
    return windowAt(elapsed, this.cfg.night_ms, this.cfg.pool_windows)
  }
  weights(woods = this.windows, target = this.target) {
    return windowWeights(woods, target, this.cfg.early_max_bp, this.cfg.late_lit_bp)
  }

  catchUp(now) {
    const clock = this.clock(now)
    let done = 0
    while (this.night < clock && done < this.cfg.max_catchup) {
      this.settleNight()
      done++
    }
    return done
  }

  nextTarget(rule) {
    let next = rule < SUPPLY_CAP ? rule : SUPPLY_CAP
    if (this.cfg.target_cap_bp > 0) {
      const cap = ((this.supply - this.hearth - this.pile) * BigInt(this.cfg.target_cap_bp)) / BP
      if (cap < next) next = cap
    }
    const min = big(this.cfg.target_min)
    return next < min ? min : next
  }

  settleNight() {
    const c = this.cfg
    const n = this.night
    const { target, pile, throwers } = this
    const ws = pile > 0n ? this.weights() : []
    const log = { night: n, outcome: 'COLD', target, pile, throwers, minted: 0n, hearth_cut: 0n, burned: 0n, hearth_burned: 0n, firestarter: this.firestarter, last_log: this.lastLog, windows: ws }
    this.pile = 0n
    this.windows = Array(c.pool_windows).fill(0n)
    this.throwers = 0
    this.firestarter = null
    this.lastLog = null
    let rule
    let moved = 0n
    if (pile > 0n && pile >= target) {
      let mint = (target * BigInt(c.mint_bp)) / BP
      if (mint > SUPPLY_CAP - this.supply) mint = SUPPLY_CAP - this.supply
      const cut = (mint * BigInt(c.hearth_cut_bp)) / BP
      const shared = mint - cut
      const weight = ws.reduce((a, w) => a + w.weight, 0n)
      this.supply += mint
      this.hearth += cut
      this.owe(n, { outcome: 'LIT', pile, pool: shared, weight, windows: ws, left: throwers, remaining: pile + shared })
      this.streak++
      const r = this.records
      r.total_minted += mint
      r.longest_streak = Math.max(r.longest_streak, this.streak)
      if (target > r.tallest_fire) r.tallest_fire = target
      r.nights_lit++
      rule = (target * (BP + BigInt(c.grow_bp))) / BP
      Object.assign(log, { outcome: 'LIT', minted: mint, hearth_cut: cut })
      moved = mint
    } else if (pile > 0n) {
      const burn = (pile * BigInt(c.smoke_bp)) / BP
      const back = pile - burn
      let hb = (this.hearth * BigInt(c.hearth_burn_bp)) / BP
      const cap = (target * BigInt(c.mint_bp)) / BP
      if (hb > cap) hb = cap
      this.hearth -= hb
      this.supply -= burn + hb
      this.owe(n, { outcome: 'SMOKED', pile, pool: back, weight: 0n, windows: [], left: throwers, remaining: back })
      this.streak = 0
      this.records.total_burned += burn + hb
      this.records.nights_smoked++
      rule = (target * (BP - BigInt(c.shrink_bp))) / BP
      Object.assign(log, { outcome: 'SMOKED', burned: burn + hb, hearth_burned: hb })
      moved = burn + hb
    } else {
      this.streak = 0
      this.records.nights_cold++
      rule = (target * (BP - BigInt(c.shrink_bp))) / BP
    }
    this.target = this.nextTarget(rule)
    Object.assign(log, { target_next: this.target, streak: this.streak, supply: this.supply })
    this.history.push({ night: n, outcome: log.outcome, target, pile, moved, supply: this.supply })
    this.last = { night: n, outcome: log.outcome, target, pile }
    this.logs.set(n, log)
    this.logs.delete(n - c.log_keep)
    this.night++
  }

  owe(night, o) {
    this.owed += o.remaining
    this.owedNights++
    this.owedByNight.set(night, o)
  }

  static creditOf(o, p) {
    const wood = sum(p.wood)
    if (o.outcome === 'LIT') {
      let weight = 0n
      for (const [w, a] of p.wood) {
        const win = o.windows[w]
        if (win && win.wood > 0n) weight += (win.weight * a) / win.wood
      }
      return wood + (o.weight > 0n ? (o.pool * weight) / o.weight : 0n)
    }
    return (wood * o.pool) / o.pile
  }

  pendingCredit(h) {
    const p = h?.pending
    if (!p || p.night >= this.night) return 0n
    const o = this.owedByNight.get(p.night)
    return o ? MockEngine.creditOf(o, p) : 0n
  }

  /** Credits what a settled night owes the account; the night's last collection moves the dust. */
  credit(account) {
    const h = this.holders.get(account)
    const p = h?.pending
    if (!p || p.night >= this.night) return { night: null, amount: 0n }
    const o = this.owedByNight.get(p.night)
    const amount = MockEngine.creditOf(o, p)
    o.left -= 1
    o.remaining -= amount
    if (o.left === 0) {
      this.owedByNight.delete(p.night)
      this.owedNights--
      this.hearth += o.remaining
      this.owed -= o.remaining
    }
    h.balance += amount
    h.pending = null
    this.balances += amount
    this.owed -= amount
    return { night: p.night, amount }
  }

  throw(actor, amount, now) {
    const a = big(amount)
    const n = this.night
    if (n < this.clock(now)) return { error: 'ended nights are still waiting to be settled: call settle, then throw again' }
    if (a < big(this.cfg.min_throw)) return { error: `the smallest throw is ${this.cfg.min_throw} base units` }
    const h = this.holders.get(actor)
    if (!h) return { error: `The account ${actor} is not registered` }
    const collected = this.credit(actor).amount
    if (h.balance < a) return { error: 'not enough free EMBER' }
    const first = !h.pending
    const window = this.windowAt(now - this.start(n))
    h.balance -= a
    if (!h.pending) h.pending = { night: n, wood: new Map() }
    h.pending.wood.set(window, (h.pending.wood.get(window) ?? 0n) + a)
    const before = this.pile
    this.balances -= a
    this.pile += a
    this.windows[window] += a
    if (first) this.throwers++
    if (!this.firestarter) this.firestarter = actor
    if (before < this.target && this.pile >= this.target) this.lastLog = { account: actor, amount: a }
    this.recent.push({ night: n, window, account: actor, amount: a, pile: this.pile, at_ms: now })
    if (this.recent.length > RECENT) this.recent.shift()
    return { ok: { night: n, window, amount: s(a), wood: s(sum(h.pending.wood)), pile: s(this.pile), target: s(this.target), collected: s(collected) } }
  }

  claimKindling(actor, now) {
    const clock = this.clock(now)
    const claims = this.kindlingNight === clock ? this.kindlingClaims : 0
    if (claims >= this.cfg.kindling_per_night) return { error: "tonight's kindling is all handed out; come back next night" }
    const k = big(this.cfg.kindling)
    if (this.hearth < k) return { error: 'the hearth is too low to hand out kindling' }
    let h = this.holders.get(actor)
    if (h?.held) return { error: 'kindling is only for accounts that never held EMBER' }
    if (!h) {
      h = { balance: 0n, nonce: 0, sponsored: true, held: false, kindled: false, pending: null }
      this.holders.set(actor, h)
      this.sponsored++
    }
    h.balance += k
    h.held = true
    h.kindled = true
    this.hearth -= k
    this.balances += k
    this.kindlingNight = clock
    this.kindlingClaims = claims + 1
    this.records.kindling_claims++
    return { ok: { night: clock, amount: s(k), left_tonight: this.cfg.kindling_per_night - this.kindlingClaims } }
  }

  collect(account, now) {
    this.catchUp(now)
    const { night, amount } = this.credit(account)
    return { account, night, amount: s(amount) }
  }

  // ---- views, shaped like the contract's JSON (U128 as strings) ----

  windowsView(ws) {
    return ws.map((w, i) => ({ window: i, wood: s(w.wood), start_pile: s(w.start), weight: s(w.weight) }))
  }

  configView() {
    return {
      version: '0.2.0-mock',
      config: this.cfg,
      founders: this.founders.map((f) => ({ account_id: f.account_id, amount: s(big(f.amount)) })),
      genesis_ms: this.genesisMs,
      genesis_supply: s(this.genesisSupply),
      supply_cap: s(SUPPLY_CAP),
      account_storage_bytes: 211,
      account_storage_cost: '2110000000000000000000',
    }
  }

  stateView(now) {
    const clock = this.clock(now)
    const claims = this.kindlingNight === clock ? this.kindlingClaims : 0
    const k = big(this.cfg.kindling)
    const affordable = this.hearth < k ? 0 : Number(this.hearth / k)
    const windowNow = this.windowAt(now - this.start(clock))
    const r = this.records
    return {
      night: this.night,
      night_start_ms: this.start(this.night),
      night_end_ms: this.end(this.night),
      now_ms: now,
      due: clock > this.night,
      nights_due: clock - this.night,
      clock_night: clock,
      window_now: windowNow,
      window_end_ms: this.start(clock) + Math.floor((this.cfg.night_ms * (windowNow + 1)) / this.cfg.pool_windows),
      windows: this.windowsView(this.weights()),
      target: s(this.target),
      pile: s(this.pile),
      throwers: this.throwers,
      reached: this.pile >= this.target,
      firestarter: this.firestarter,
      last_log: this.lastLog ? { account: this.lastLog.account, amount: s(this.lastLog.amount) } : null,
      streak: this.streak,
      records: { ...r, tallest_fire: s(r.tallest_fire), total_minted: s(r.total_minted), total_burned: s(r.total_burned) },
      hearth: s(this.hearth),
      supply: s(this.supply),
      owed: s(this.owed),
      owed_nights: this.owedNights,
      kindling_left_tonight: Math.min(Math.max(0, this.cfg.kindling_per_night - claims), affordable),
      accounts_sponsored: this.sponsored,
      max_accounts: this.cfg.max_accounts,
      last: this.last ? { night: this.last.night, outcome: this.last.outcome, target: s(this.last.target), pile: s(this.last.pile) } : null,
    }
  }

  holderView(account) {
    const h = this.holders.get(account)
    const credited = h?.balance ?? 0n
    const pending = this.pendingCredit(h)
    const p = h?.pending
    let weight = 0n
    if (p) {
      const ws = p.night === this.night ? this.weights() : this.owedByNight.get(p.night)?.outcome === 'LIT' ? this.owedByNight.get(p.night).windows : null
      if (ws) for (const [w, a] of p.wood) if (ws[w]?.wood > 0n) weight += (ws[w].weight * a) / ws[w].wood
    }
    return {
      account,
      registered: !!h,
      balance: s(credited + pending),
      credited: s(credited),
      pending: s(pending),
      wood_night: p?.night ?? null,
      wood: s(p ? sum(p.wood) : 0n),
      wood_by_window: p ? [...p.wood].sort((a, b) => a[0] - b[0]).map(([window, wood]) => ({ window, wood: s(wood) })) : [],
      weight: s(weight),
      nonce: h?.nonce ?? 0,
      sponsored: !!h?.sponsored,
      held: !!h?.held,
      kindled: !!h?.kindled,
      may_take_kindling: !h?.held && account !== this.contract,
    }
  }

  nightView(n) {
    if (n === this.night) {
      return {
        night: n,
        outcome: 'OPEN',
        start_ms: this.start(n),
        end_ms: this.end(n),
        target: s(this.target),
        pile: s(this.pile),
        throwers: this.throwers,
        minted: '0',
        hearth_cut: '0',
        burned: '0',
        hearth_burned: '0',
        target_next: null,
        streak: this.streak,
        supply: null,
        firestarter: this.firestarter,
        last_log: this.lastLog ? { account: this.lastLog.account, amount: s(this.lastLog.amount) } : null,
        windows: this.windowsView(this.weights()),
        owed: null,
        uncollected: null,
      }
    }
    const log = this.logs.get(n)
    if (!log) return null
    const o = this.owedByNight.get(n)
    return {
      night: n,
      outcome: log.outcome,
      start_ms: this.start(n),
      end_ms: this.end(n),
      target: s(log.target),
      pile: s(log.pile),
      throwers: log.throwers,
      minted: s(log.minted),
      hearth_cut: s(log.hearth_cut),
      burned: s(log.burned),
      hearth_burned: s(log.hearth_burned),
      target_next: s(log.target_next),
      streak: log.streak,
      supply: s(log.supply),
      firestarter: log.firestarter,
      last_log: log.last_log ? { account: log.last_log.account, amount: s(log.last_log.amount) } : null,
      windows: this.windowsView(log.windows),
      owed: s(o?.remaining ?? 0n),
      uncollected: o?.left ?? 0,
    }
  }

  historyView(from, limit = 100) {
    const first = this.history.length ? this.history[0].night : 1
    const f = Math.max(from ?? first, first)
    return this.history
      .filter((r) => r.night >= f)
      .slice(0, Math.min(limit, 500))
      .map((r) => ({
        night: r.night,
        target: s(r.target),
        pile: s(r.pile),
        outcome: r.outcome,
        minted: s(r.outcome === 'LIT' ? r.moved : 0n),
        burned: s(r.outcome === 'LIT' ? 0n : r.moved),
        supply: s(r.supply),
      }))
  }

  estimateView(amount, now) {
    const a = big(amount)
    const clock = this.clock(now)
    const window = this.windowAt(now - this.start(clock))
    const open = clock === this.night
    const woods = open ? [...this.windows] : Array(this.cfg.pool_windows).fill(0n)
    let target = this.target
    if (!open && target < big(this.cfg.target_min)) target = big(this.cfg.target_min)
    woods[window] += a
    const { wood: x, weight: w } = this.weights(woods, target)[window]
    const weight = x === 0n ? 0n : (w * a) / x
    return { night: clock, window, amount: s(a), weight: s(weight), factor_bp: a === 0n ? 0 : Number(weight / a) }
  }

  recentView() {
    return this.recent.map((t) => ({ night: t.night, window: t.window, account: t.account, amount: s(t.amount), pile: s(t.pile), at_ms: t.at_ms }))
  }

  metadataView() {
    const l = this.last ?? { pile: this.pile, target: this.target, outcome: 'OPEN' }
    const nights = this.history.slice(-ICON_NIGHTS).map((r) => r.outcome)
    return { spec: 'ft-1.0.0', name: this.cfg.name, symbol: this.cfg.symbol, icon: iconDataUrl(drawIcon(l.pile, l.target, l.outcome, this.streak, nights)), reference: null, reference_hash: null, decimals: this.cfg.decimals }
  }

  /** supply == balances + pile + hearth + owed, and the pile equals its windows. */
  audit() {
    let free = 0n
    for (const h of this.holders.values()) free += h.balance
    const windows = this.windows.reduce((a, b) => a + b, 0n)
    return {
      balanced: this.balances + this.pile + this.hearth + this.owed === this.supply && windows === this.pile && free === this.balances,
      ledger: this.genesisSupply + this.records.total_minted === this.supply + this.records.total_burned,
    }
  }
}

// ---- the coin's face, as contract/src/icon.rs draws it ---------------------------------------------

function iconLabel(outcome, streak) {
  if (outcome === 'LIT') return [`LIT ×${streak}`, 8 + Math.floor(Math.min(streak, 15) / 3), '#ffd23f']
  if (outcome === 'SMOKED') return ['SMOKED', 8, '#c9c5d6']
  if (outcome === 'COLD') return ['COLD', 8, '#9fbfe0']
  return ['FIRST NIGHT', 7, '#ffd8a0']
}

function flameHeight(pile, pct, lit) {
  if (pile === 0n) return 0
  if (lit || pct >= 100) return 14 + Math.floor(((Math.max(pct, 100) - 100) * 8) / 50)
  return 3 + Math.floor((pct * 9) / 100)
}

function flame(x, base, h, w, fill) {
  const top = base - h
  const mid = base - Math.floor((h * 11) / 20)
  const [l, r] = [x - w, x + w]
  return `<path d='M${x} ${top}C${r} ${mid} ${r} ${base} ${x} ${base}C${l} ${base} ${l} ${mid} ${x} ${top}Z' fill='${fill}'/>`
}

export function drawIcon(pile, target, outcome, streak, nights = []) {
  const p = big(pile)
  const t = big(target)
  let pct = t === 0n ? 150 : Number((p * 100n) / t)
  if (pct > 150) pct = 150
  const smoky = outcome === 'SMOKED' || outcome === 'COLD'
  const h = flameHeight(p, pct, outcome === 'LIT')
  let out = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='#1d1426'/>"
  const [word, size, color] = iconLabel(outcome, streak)
  out += `<text x='32' y='${4 + size}' text-anchor='middle' font-family='sans-serif' font-size='${size}' font-weight='700' fill='${color}'>${word}</text>`
  if (h > 0) {
    const w = 4 + Math.floor(h / 3)
    const [outer, inner] = smoky ? ['#b4521f', '#e09a3a'] : ['#ff7a1a', '#ffd23f']
    out += flame(32, 42, h, w, outer) + flame(32, 42, Math.floor((h * 3) / 5), Math.floor((w * 3) / 5), inner)
  } else {
    out += "<g fill='#e0532a'><circle cx='27' cy='38' r='1.6'/><circle cx='32' cy='37' r='1.6'/><circle cx='37' cy='38' r='1.6'/></g>"
  }
  if (smoky) {
    const top = h === 0 ? 32 : 42 - h - 2
    out += `<g fill='#8f8c99' opacity='.8'><circle cx='28' cy='${top}' r='4'/><circle cx='36' cy='${top - 6}' r='5'/></g>`
  }
  out += "<path d='M19 47L45 40M19 40L45 47' stroke='#7b4a26' stroke-width='4' stroke-linecap='round'/>"
  nights.forEach((o, i) => {
    const x = 10 + i * 7
    if (o === 'LIT') out += flame(x, 59, 7, 3, '#ff7a1a')
    else if (o === 'SMOKED') out += `<circle cx='${x}' cy='56' r='2.6' fill='#8f8c99'/>`
    else out += `<circle cx='${x}' cy='56' r='2' fill='none' stroke='#6c7a90'/>`
  })
  return out + '</svg>'
}

export function iconDataUrl(svg) {
  let out = 'data:image/svg+xml,'
  for (const b of new TextEncoder().encode(svg)) {
    const ch = String.fromCharCode(b)
    if (/[A-Za-z0-9\-_.!~*'()/:;=,]/.test(ch)) out += ch
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

// ---- a world of demo bots and made-up players ----------------------------------------------------

const BOTS = [
  { id: 'demo-bot-early-a.bonfire.testnet', fund: 40_000, kind: 'early', amount: 200 },
  { id: 'demo-bot-early-b.bonfire.testnet', fund: 30_000, kind: 'early', amount: 150 },
  { id: 'demo-bot-steady.bonfire.testnet', fund: 15_000, kind: 'steady', amount: 150 },
  { id: 'demo-bot-late.bonfire.testnet', fund: 5_000, kind: 'late', amount: 100 },
  { id: 'demo-bot-idle.bonfire.testnet', fund: 10_000, kind: 'idle', amount: 0 },
]

/**
 * The engine plus a schedule: bots throw as sim/params.json describes them, and a crowd of made-up
 * players throws now and then. `advance(now)` plays every scheduled throw up to `now`.
 */
export class MockWorld {
  constructor({ nightMs = 300_000, genesisMs, seed = 7, players = 16 }) {
    const r = rng(seed)
    this.players = Array.from({ length: players }, () => ({ id: fakeHex(r), fund: 400 + Math.floor(r() * 1200) }))
    const founders = [...BOTS.map((b) => ({ account_id: b.id, amount: E(b.fund) })), ...this.players.map((p) => ({ account_id: p.id, amount: E(p.fund) }))]
    this.engine = new MockEngine(mockConfig(nightMs), founders, genesisMs)
    this.planned = new Map() // night -> [{t, account, amount}] sorted by t
    this.done = new Map() // night -> index of the next unplayed throw
    this.overrides = new Map() // night -> plan (presets)
    this.collects = [] // [{t, account}]: another page collecting for an account (presets)
  }

  plan(n) {
    if (this.overrides.has(n)) return this.overrides.get(n)
    if (this.planned.has(n)) return this.planned.get(n)
    const r = rng(hashSeed('night' + n) ^ 0x5bd1e995)
    const nm = this.engine.cfg.night_ms
    const start = this.engine.start(n)
    const out = []
    const jitter = (a) => Math.round(a * (0.75 + r() * 0.5))
    for (const b of BOTS) {
      if (b.kind === 'early' && r() < 0.9) out.push({ t: start + Math.floor(r() * 0.2 * nm), account: b.id, amount: jitter(b.amount) })
      if (b.kind === 'steady' && r() < 0.85) out.push({ t: start + Math.floor((0.4 + r() * 0.4) * nm), account: b.id, amount: jitter(b.amount), cond: 'steady' })
      if (b.kind === 'late' && r() < 0.9) out.push({ t: start + Math.floor((0.9 + r() * 0.09) * nm), account: b.id, amount: b.amount, cond: 'late' })
    }
    // a crowd that grows over the first nights, with quiet nights between
    const crowd = Math.floor(r() * Math.min(7, 1 + n / 4))
    const picked = [...this.players].sort(() => r() - 0.5).slice(0, crowd)
    for (const p of picked) out.push({ t: start + Math.floor(r() * 0.97 * nm), account: p.id, amount: 10 + Math.round(r() * 60) })
    out.sort((a, b) => a.t - b.t)
    this.planned.set(n, out)
    return out
  }

  /** Plays every scheduled throw up to `now`. Each throw first settles ended nights, as a call would. */
  advance(now) {
    const e = this.engine
    while (this.collects.length && this.collects[0].t <= now) {
      const c = this.collects.shift()
      e.collect(c.account, c.t)
    }
    for (let guard = 0; guard < 100_000; guard++) {
      const ev = this.nextEvent(now)
      if (!ev) break
      this.done.set(ev.n, ev.i + 1)
      e.catchUp(ev.item.t)
      if (e.night !== ev.n || !this.wants(ev.item)) continue
      const h = e.holders.get(ev.item.account)
      const amount = ev.item.units ?? E(ev.item.amount)
      if (h && h.balance + e.pendingCredit(h) >= amount) e.throw(ev.item.account, amount, ev.item.t)
    }
  }

  /** The next scheduled throw at or before `now`, on the open night or a later one. */
  nextEvent(now) {
    const e = this.engine
    const last = e.clock(now)
    for (let n = e.night; n <= last; n++) {
      const plan = this.plan(n)
      const i = this.done.get(n) ?? 0
      if (i < plan.length) return plan[i].t <= now ? { n, i, item: plan[i] } : null
    }
    return null
  }

  wants(t) {
    const e = this.engine
    if (t.cond === 'steady') return e.streak >= 2 || e.pile * 10n >= e.target * 6n
    if (t.cond === 'late') return e.pile < e.target && e.pile * 10n >= e.target * 8n && e.pile + E(t.amount) >= e.target
    return true
  }
}

// ---- presets for screenshots ----------------------------------------------------------------------

/**
 * scene: first (an empty first visit), newcomer (a first visit to a running world, no EMBER yet), early, close (near the target, late in the night), late
 * (a newcomer arriving in the last quarter, half the target still missing), collected (the player is owed last
 * night's wood, and another page collects it a few seconds in), lit / smoke / cold (a night that just ended, so the
 * page settles it and plays the outcome), live (a running world, the default).
 */
export function buildMock({ scene = 'live', nightMs = 300_000, now = Date.now(), me }) {
  const P = {
    first: { nights: 0, at: 0.05, pct: 0, crowd: 0, mine: null },
    newcomer: { nights: 30, at: 0.22, pct: 0.3, crowd: 4, mine: null },
    early: { nights: 26, at: 0.12, pct: 0.22, crowd: 3, mine: { fund: 460, wood: 0 } },
    close: { nights: 33, at: 0.86, pct: 0.9, crowd: 8, mine: { fund: 520, wood: 120 } },
    late: { nights: 30, at: 0.88, pct: 0.5, crowd: 4, mine: null },
    collected: { nights: 30, at: 0.15, pct: 0.25, crowd: 3, mine: { fund: 480, wood: 0 }, owed: true, helpAfterMs: 9000 },
    lit: { nights: 39, at: 1.004, pct: 1.16, crowd: 9, mine: { fund: 600, wood: 180 } },
    smoke: { nights: 39, at: 1.004, pct: 0.64, crowd: 5, mine: { fund: 600, wood: 90 } },
    cold: { nights: 39, at: 1.004, pct: 0, crowd: 0, mine: { fund: 600, wood: 0 } },
    live: { nights: 30, at: 0.3, pct: null, crowd: null, mine: { fund: 480, wood: 0 } },
  }[scene]
  if (!P) throw new Error('unknown mock scene ' + scene)
  const n = P.nights + 1 // the open night
  const genesisMs = Math.floor(now - (P.nights + P.at) * nightMs)
  const world = new MockWorld({ nightMs, genesisMs })
  const e = world.engine
  const start = e.start(n)
  // History: the schedule plays until the open night begins. The player joined five nights ago.
  if (P.mine) {
    const joinNight = Math.max(1, n - 5)
    world.advance(e.start(joinNight) + 1000)
    e.catchUp(e.start(joinNight) + 1000)
    e.claimKindling(me, e.start(joinNight) + 1500)
    const extra = E(P.mine.fund) - big(e.cfg.kindling)
    if (extra > 0n) {
      // a gift from the idle bot stands in for rewards of earlier nights
      e.holders.get(BOTS[4].id).balance -= extra
      e.holders.get(me).balance += extra
    }
    for (let k = joinNight; k < n; k++) {
      const plan = world.plan(k)
      plan.push({ t: e.start(k) + Math.floor(nightMs * (0.03 + 0.05 * ((k * 7) % 4))), account: me, amount: 20 + ((k * 37) % 4) * 15 })
      plan.sort((a, b) => a.t - b.t)
    }
  }
  world.advance(start - 1)
  e.catchUp(start + 1)
  // The player's credit from the last night is collected, as the next action would; or, for
  // `collected`, left owed until another page collects it.
  if (P.mine && !P.owed) e.credit(me)
  if (P.helpAfterMs) world.collects.push({ t: now + P.helpAfterMs, account: me })
  if (P.pct !== null) {
    // The open night: a crafted pile.
    const target = e.target
    const want = (target * BigInt(Math.round(P.pct * 1000))) / 1000n
    const mineWood = P.mine?.wood ? E(P.mine.wood) : 0n
    const at = Math.min(P.at, 0.999)
    const crowd = [...BOTS.slice(0, 4).map((b) => b.id), ...world.players.map((p) => p.id)].slice(0, P.crowd)
    const r = rng(n * 977)
    const plan = []
    let rest = want - mineWood
    crowd.forEach((acc, i) => {
      const share = i === crowd.length - 1 ? rest : (rest * BigInt(Math.round((0.5 + r()) * 1000))) / BigInt(1000 * (crowd.length - i))
      rest -= share
      plan.push({ t: start + Math.floor((r() * at * 0.9 + 0.005) * nightMs), account: acc, units: share })
    })
    if (mineWood > 0n) plan.push({ t: start + Math.floor(at * 0.3 * nightMs), account: me, units: mineWood })
    plan.sort((a, b) => a.t - b.t)
    for (const p of plan) if (p.units > 0n) e.throw(p.account, p.units, p.t)
    // after now: a few more throws keep the night alive on screen (not for the outcome presets)
    const later = []
    if (P.at < 1) for (let k = 0; k < 4; k++) later.push({ t: now + Math.floor((6 + k * 9 + r() * 6) * 1000), account: world.players[(k + 5) % world.players.length].id, amount: 8 + Math.round(r() * 30) })
    world.overrides.set(n, later)
    // a night that just ended waits for the page to settle it: nobody else calls in the first seconds
    if (P.at >= 1) world.overrides.set(n + 1, world.plan(n + 1).filter((x) => x.t > now + 8000))
  } else {
    world.done.set(n, 0)
    world.advance(now)
  }
  return world
}

// ---- the client --------------------------------------------------------------------------------

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** Same surface as chain.js's Client, served from a MockWorld in this tab. */
export class MockClient {
  constructor({ scene = 'live', nightMs = 300_000, latency = 220, contract = 'bonfire-stage.testnet' } = {}) {
    this.mock = true
    this.scene = scene
    this.nightMs = nightMs
    this.latency = latency
    this.contract = contract
    this.identity = null
    this._world = null
    this.txs = []
    this.onTx = null
    this.r = rng(99)
    this.rpc = { host: 'mock (in this tab)' }
    this.pool = { lastKey: null }
    this.canAct = true
  }

  async setIdentity(identity) {
    this.identity = identity
    return this.holder()
  }

  /** The world is made on first use, around the player's account (the presets give it wood). */
  get world() {
    if (!this._world) this._world = buildMock({ scene: this.scene, nightMs: this.nightMs, me: this.identity?.account ?? 'f'.repeat(64) })
    return this._world
  }

  async call(fn) {
    await wait(this.latency * (0.4 + this.r()))
    this.world.advance(Date.now())
    return fn(this.world.engine)
  }

  config() {
    return this.call((e) => e.configView())
  }
  state() {
    return this.call((e) => e.stateView(Date.now()))
  }
  holder(account = this.identity?.account) {
    return this.call((e) => e.holderView(account))
  }
  night(n) {
    return this.call((e) => e.nightView(n))
  }
  history(from, limit) {
    return this.call((e) => e.historyView(from, limit))
  }
  estimate(amount) {
    return this.call((e) => e.estimateView(amount, Date.now()))
  }
  recentThrows() {
    return this.call((e) => e.recentView())
  }
  ftMetadata() {
    return this.call((e) => e.metadataView())
  }
  accessKeys() {
    return this.call(() => [])
  }
  viewAccount() {
    return this.call(() => ({ code_hash: 'mock: no code on chain' }))
  }

  record(kind, failure = null, extra = {}) {
    const entry = { kind, hash: fakeHash(this.r), gas: 1.5e12 + this.r() * 2e12, at: Date.now(), failure, mock: true, ...extra }
    this.txs.unshift(entry)
    this.txs = this.txs.slice(0, 40)
    this.onTx?.(entry)
    return entry
  }

  async act(actionJson) {
    await wait(this.latency * 2 + this.r() * 500)
    const now = Date.now()
    const w = this.world
    w.advance(now)
    const e = w.engine
    const me = this.identity.account
    const settled = e.catchUp(now)
    const collected = e.credit(me).amount
    const a = JSON.parse(actionJson)
    const named = a.throw?.night ?? a.claim_kindling?.night ?? a.collect?.night
    const clock = e.clock(now)
    let res
    if (named !== clock) res = { error: `the action is for night ${named}, but this is night ${clock}` }
    else if (a.throw) res = e.throw(me, big(a.throw.amount), now)
    else if (a.claim_kindling) res = e.claimKindling(me, now)
    else if (a.collect) res = { ok: true }
    else res = { error: 'unknown action' }
    const h = e.holders.get(me)
    if (h) h.nonce += 1
    this.record('act', null, { action: Object.keys(a)[0] ?? null, refused: res.error ?? null })
    return { ok: !res.error, error: res.error ?? null, nonce: h?.nonce ?? 0, night: e.night, settled, collected: s(collected) }
  }

  async settle() {
    await wait(this.latency * 2)
    const now = Date.now()
    this.world.advance(now)
    const e = this.world.engine
    const settled = e.catchUp(now)
    this.record('settle')
    return { settled, night: e.night, nights_due: e.clock(now) - e.night, ends_ms: e.end(e.night) }
  }

  async collect(account) {
    await wait(this.latency * 2)
    const now = Date.now()
    this.world.advance(now)
    const out = this.world.engine.collect(account, now)
    this.record('collect', null, { for: account })
    return out
  }
}
