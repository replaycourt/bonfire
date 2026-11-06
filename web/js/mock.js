// MOCK MODE, for development only: `?mock=1` in the URL. Never active otherwise.
//
// A copy of the contract's ritual in BigInt (same weights, same rounding, same views), demo bots and
// a few made-up players throwing on a schedule, and a client with the same methods as the real one.
// Nothing here touches the network. It exists so every state of the page can be seen and
// screenshotted without a deployment: `&scene=first|early|close|lit|smoke|live`, `&night=<seconds>`.
import { BP, big, clockNight, hashSeed, kindlingAction } from './logic.js'

const DEC = 18
const E = (whole) => BigInt(Math.round(whole * 1000)) * 10n ** BigInt(DEC - 3)
const SUPPLY_CAP = 1n << 112n
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** The testnet launch parameters (sim/params.json), as `config().config` would show them. */
export function mockConfig(nightMs = 300_000) {
  return {
    name: 'Bonfire Ember',
    symbol: 'EMBER',
    decimals: DEC,
    night_ms: nightMs,
    hearth_genesis: E(400_000).toString(),
    target_start: E(4000).toString(),
    target_min: E(1000).toString(),
    grow_bp: 700,
    shrink_bp: 1000,
    mint_bp: 500,
    hearth_cut_bp: 2000,
    smoke_bp: 100,
    hearth_burn_bp: 10,
    early_max_bp: 60_000,
    late_lit_bp: 1000,
    min_throw: E(1).toString(),
    kindling: E(2000).toString(),
    kindling_per_night: 5,
    max_throwers_per_night: 88,
    max_accounts: 1000,
    max_catchup: 30,
    log_keep: 48,
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

// ---- the contract, in miniature -------------------------------------------------------------------

export class MockEngine {
  constructor(cfg, founders, genesisMs, contract = 'bonfire-coin.testnet') {
    this.cfg = cfg
    this.contract = contract
    this.genesisMs = genesisMs
    this.founders = founders
    this.holders = new Map()
    this.night = 1
    this.target = big(cfg.target_start)
    this.pile = 0n
    this.weight = 0n
    this.tonight = []
    this.hearth = big(cfg.hearth_genesis)
    this.supply = this.hearth
    this.balances = 0n
    this.streak = 0
    this.records = { longest_streak: 0, tallest_fire: 0n, total_minted: 0n, total_burned: 0n, nights_lit: 0, nights_smoke: 0, nights_empty: 0, kindling_claims: 0 }
    this.last = null
    this.kindlingNight = 1
    this.kindlingClaims = 0
    this.sponsored = 0
    this.logs = new Map()
    this.history = []
    for (const f of founders) {
      this.holders.set(f.account_id, { balance: big(f.amount), wood: 0n, weight: 0n, nonce: 0, sponsored: true, held: true, kindled: false })
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
  earlyBp(elapsed) {
    const span = BigInt(this.cfg.early_max_bp - 10_000)
    const e = BigInt(Math.floor(Math.max(0, Math.min(elapsed, this.cfg.night_ms))))
    return this.cfg.early_max_bp - Number((span * e) / BigInt(this.cfg.night_ms))
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

  settleNight() {
    const n = this.night
    const target = this.target
    const pile = this.pile
    const log = { night: n, outcome: 'empty', target, pile, minted: 0n, hearth_cut: 0n, unminted: 0n, burned: 0n, hearth_burned: 0n, to_hearth: 0n, throwers: [] }
    let next
    let moved
    if (pile > 0n && pile >= target) {
      let mint = (target * BigInt(this.cfg.mint_bp)) / BP
      if (mint > SUPPLY_CAP - this.supply) mint = SUPPLY_CAP - this.supply
      const cut = (mint * BigInt(this.cfg.hearth_cut_bp)) / BP
      const pool = mint - cut
      let shares = 0n
      for (const a of this.tonight) {
        const h = this.holders.get(a)
        const share = this.weight > 0n ? (pool * h.weight) / this.weight : 0n
        log.throwers.push({ account: a, wood: h.wood, weight: h.weight, paid: h.wood + share })
        h.balance += h.wood + share
        h.wood = 0n
        h.weight = 0n
        shares += share
      }
      const minted = cut + shares
      this.balances += pile + shares
      this.hearth += cut
      this.supply += minted
      this.streak++
      const r = this.records
      r.total_minted += minted
      r.longest_streak = Math.max(r.longest_streak, this.streak)
      if (target > r.tallest_fire) r.tallest_fire = target
      r.nights_lit++
      next = target + (target * BigInt(this.cfg.grow_bp)) / BP
      if (next > SUPPLY_CAP) next = SUPPLY_CAP
      Object.assign(log, { outcome: 'lit', minted, hearth_cut: cut, unminted: pool - shares })
      moved = minted
    } else {
      const burn = (pile * BigInt(this.cfg.smoke_bp)) / BP
      const backPool = pile - burn
      let returned = 0n
      for (const a of this.tonight) {
        const h = this.holders.get(a)
        const back = (backPool * h.wood) / pile
        log.throwers.push({ account: a, wood: h.wood, weight: h.weight, paid: back })
        h.balance += back
        h.wood = 0n
        h.weight = 0n
        returned += back
      }
      const toHearth = backPool - returned
      const hearthBurned = (this.hearth * BigInt(this.cfg.hearth_burn_bp)) / BP
      this.hearth = this.hearth - hearthBurned + toHearth
      this.balances += returned
      const burned = burn + hearthBurned
      this.supply -= burned
      this.streak = 0
      this.records.total_burned += burned
      if (pile === 0n) this.records.nights_empty++
      else this.records.nights_smoke++
      next = target - (target * BigInt(this.cfg.shrink_bp)) / BP
      const min = big(this.cfg.target_min)
      if (next < min) next = min
      Object.assign(log, { outcome: pile === 0n ? 'empty' : 'smoke', burned, hearth_burned: hearthBurned, to_hearth: toHearth })
      moved = burned
    }
    this.pile = 0n
    this.weight = 0n
    this.tonight = []
    this.target = next
    log.target_next = next
    log.streak = this.streak
    log.supply = this.supply
    this.history.push({ night: n, outcome: log.outcome, target, pile, moved, supply: this.supply })
    this.last = { night: n, outcome: log.outcome, target, pile }
    this.logs.set(n, log)
    this.logs.delete(n - this.cfg.log_keep)
    this.night++
  }

  throw(actor, amount, now) {
    const a = big(amount)
    if (this.night < this.clock(now)) return { error: 'ended nights are still waiting to be settled: call settle, then throw again' }
    if (a < big(this.cfg.min_throw)) return { error: 'the smallest throw is ' + this.cfg.min_throw + ' base units' }
    const h = this.holders.get(actor)
    if (!h) return { error: `The account ${actor} is not registered` }
    if (h.balance < a) return { error: 'not enough free EMBER' }
    const first = h.wood === 0n
    if (first && this.tonight.length >= this.cfg.max_throwers_per_night) return { error: "tonight's fire has no seats left" }
    const early = this.earlyBp(now - this.start(this.night))
    const below = this.pile >= this.target ? 0n : a < this.target - this.pile ? a : this.target - this.pile
    const weight = below * BigInt(early) + (a - below) * BigInt(this.cfg.late_lit_bp)
    h.balance -= a
    h.wood += a
    h.weight += weight
    this.balances -= a
    this.pile += a
    this.weight += weight
    if (first) this.tonight.push(actor)
    return { ok: { night: this.night, amount: a.toString(), weight: weight.toString(), wood: h.wood.toString(), weight_total: h.weight.toString(), pile: this.pile.toString(), target: this.target.toString() } }
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
      h = { balance: 0n, wood: 0n, weight: 0n, nonce: 0, sponsored: true, held: false, kindled: false }
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
    return { ok: { night: clock, amount: k.toString(), left_tonight: this.cfg.kindling_per_night - this.kindlingClaims } }
  }

  // ---- views, shaped like the contract's JSON (U128 as strings) ----

  configView() {
    return {
      version: '0.1.0-mock',
      config: this.cfg,
      founders: this.founders.map((f) => ({ account_id: f.account_id, amount: big(f.amount).toString() })),
      genesis_ms: this.genesisMs,
      genesis_supply: this.genesisSupply.toString(),
      supply_cap: SUPPLY_CAP.toString(),
      account_storage_bytes: 166,
      account_storage_cost: '1660000000000000000000',
      max_throwers_limit: 88,
    }
  }

  stateView(now) {
    const clock = this.clock(now)
    const claims = this.kindlingNight === clock ? this.kindlingClaims : 0
    const k = big(this.cfg.kindling)
    const affordable = this.hearth < k ? 0 : Number(this.hearth / k)
    const s = (v) => v.toString()
    const r = this.records
    return {
      night: this.night,
      night_start_ms: this.start(this.night),
      night_end_ms: this.end(this.night),
      now_ms: now,
      due: clock > this.night,
      nights_due: clock - this.night,
      clock_night: clock,
      target: s(this.target),
      pile: s(this.pile),
      throwers: this.tonight.length,
      max_throwers: this.cfg.max_throwers_per_night,
      weight: s(this.weight),
      reached: this.pile >= this.target,
      early_bp_now: this.earlyBp(now - this.start(clock)),
      streak: this.streak,
      records: { ...r, tallest_fire: s(r.tallest_fire), total_minted: s(r.total_minted), total_burned: s(r.total_burned) },
      hearth: s(this.hearth),
      supply: s(this.supply),
      kindling_left_tonight: Math.min(Math.max(0, this.cfg.kindling_per_night - claims), affordable),
      accounts_sponsored: this.sponsored,
      max_accounts: this.cfg.max_accounts,
      last: this.last ? { night: this.last.night, outcome: this.last.outcome, target: s(this.last.target), pile: s(this.last.pile) } : null,
    }
  }

  holderView(account) {
    const h = this.holders.get(account)
    return {
      account,
      registered: !!h,
      balance: (h?.balance ?? 0n).toString(),
      wood: (h?.wood ?? 0n).toString(),
      weight: (h?.weight ?? 0n).toString(),
      nonce: h?.nonce ?? 0,
      sponsored: !!h?.sponsored,
      held: !!h?.held,
      kindled: !!h?.kindled,
      may_take_kindling: !h?.held && account !== this.contract,
    }
  }

  nightView(n) {
    const s = (v) => v.toString()
    if (n === this.night) {
      return {
        night: n,
        outcome: 'open',
        start_ms: this.start(n),
        end_ms: this.end(n),
        target: s(this.target),
        pile: s(this.pile),
        minted: '0',
        hearth_cut: '0',
        unminted: '0',
        burned: '0',
        hearth_burned: '0',
        to_hearth: '0',
        target_next: null,
        streak: this.streak,
        supply: null,
        throwers: this.tonight.map((a) => {
          const h = this.holders.get(a)
          return { account: a, wood: s(h.wood), weight: s(h.weight), back: '0', reward: '0', lost: '0' }
        }),
      }
    }
    const log = this.logs.get(n)
    if (!log) return null
    const lit = log.outcome === 'lit'
    return {
      night: n,
      outcome: log.outcome,
      start_ms: this.start(n),
      end_ms: this.end(n),
      target: s(log.target),
      pile: s(log.pile),
      minted: s(log.minted),
      hearth_cut: s(log.hearth_cut),
      unminted: s(log.unminted),
      burned: s(log.burned),
      hearth_burned: s(log.hearth_burned),
      to_hearth: s(log.to_hearth),
      target_next: s(log.target_next),
      streak: log.streak,
      supply: s(log.supply),
      throwers: log.throwers.map((t) => ({
        account: t.account,
        wood: s(t.wood),
        weight: s(t.weight),
        back: s(lit ? t.wood : t.paid),
        reward: s(lit ? t.paid - t.wood : 0n),
        lost: s(lit ? 0n : t.wood - t.paid),
      })),
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
        target: r.target.toString(),
        pile: r.pile.toString(),
        outcome: r.outcome,
        minted: (r.outcome === 'lit' ? r.moved : 0n).toString(),
        burned: (r.outcome === 'lit' ? 0n : r.moved).toString(),
        supply: r.supply.toString(),
      }))
  }

  metadataView() {
    const l = this.last ?? { pile: this.pile, target: this.target, outcome: 'open' }
    return { spec: 'ft-1.0.0', name: this.cfg.name, symbol: this.cfg.symbol, icon: iconDataUrl(drawIcon(l.pile, l.target, l.outcome, this.streak)), reference: null, reference_hash: null, decimals: this.cfg.decimals }
  }

  /** supply == balances + pile + hearth, and the pile equals its throwers' wood. */
  audit() {
    const recomputed = this.tonight.reduce((s, a) => s + this.holders.get(a).wood, 0n)
    let free = 0n
    for (const h of this.holders.values()) free += h.balance
    return { balanced: this.balances + this.pile + this.hearth === this.supply && recomputed === this.pile && free === this.balances, ledger: this.genesisSupply + this.records.total_minted === this.supply + this.records.total_burned }
  }
}

// ---- the coin's face, as icon.rs draws it --------------------------------------------------------

function flameHeight(pile, pct) {
  if (pile === 0n) return 0
  if (pct >= 100) return 24 + Math.floor(((pct - 100) * 10) / 50)
  return 4 + Math.floor((pct * 16) / 100)
}

function flame(h, w, fill) {
  const top = 44 - h
  const mid = 44 - Math.floor((h * 11) / 20)
  const [l, r] = [32 - w, 32 + w]
  return `<path d='M32 ${top}C${r} ${mid} ${r} 44 32 44C${l} 44 ${l} ${mid} 32 ${top}Z' fill='${fill}'/>`
}

export function drawIcon(pile, target, outcome, streak) {
  const p = big(pile)
  const t = big(target)
  let pct = t === 0n ? 150 : Number((p * 100n) / t)
  if (pct > 150) pct = 150
  const smoky = outcome === 'smoke' || outcome === 'empty'
  const h = flameHeight(p, pct)
  let s = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='#1d1426'/>"
  if (h > 0) {
    const w = 6 + Math.floor(h / 3)
    const [outer, inner] = smoky ? ['#b4521f', '#e09a3a'] : ['#ff7a1a', '#ffd23f']
    s += flame(h, w, outer) + flame(Math.floor((h * 3) / 5), Math.floor((w * 3) / 5), inner)
  } else {
    s += "<g fill='#e0532a'><circle cx='25' cy='39' r='2'/><circle cx='32' cy='38' r='2'/><circle cx='39' cy='40' r='2'/></g>"
  }
  if (smoky) {
    const top = h === 0 ? 30 : Math.max(44 - h - 8, 22)
    s += `<g fill='#8f8c99' opacity='.8'><circle cx='27' cy='${top}' r='6'/><circle cx='37' cy='${top - 6}' r='7'/><circle cx='30' cy='${top - 13}' r='5'/></g>`
  }
  s += "<path d='M16 50L48 42M16 42L48 50' stroke='#7b4a26' stroke-width='5' stroke-linecap='round'/>"
  s += `<text x='32' y='61' text-anchor='middle' font-family='sans-serif' font-size='9' font-weight='700' fill='#ffd8a0'>${streak}</text></svg>`
  return s
}

export function iconDataUrl(svg) {
  let out = 'data:image/svg+xml,'
  for (const ch of svg) {
    if (/[A-Za-z0-9\-_.!~*'()/:;=,]/.test(ch)) out += ch
    else out += '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

// ---- a world of bots and made-up players --------------------------------------------------------

const BOTS = [
  { id: 'bot-early-a.bonfire-coin.testnet', fund: 200_000, kind: 'early', amount: 2000 },
  { id: 'bot-early-b.bonfire-coin.testnet', fund: 150_000, kind: 'early', amount: 1500 },
  { id: 'bot-steady.bonfire-coin.testnet', fund: 100_000, kind: 'steady', amount: 1500 },
  { id: 'bot-late.bonfire-coin.testnet', fund: 50_000, kind: 'late', amount: 1000 },
  { id: 'bot-idle.bonfire-coin.testnet', fund: 100_000, kind: 'idle', amount: 0 },
]

/**
 * The engine plus a schedule: bots throw as sim/params.json describes them, and a crowd of made-up
 * players throws now and then. `advance(now)` plays every scheduled throw up to `now`.
 */
export class MockWorld {
  constructor({ nightMs = 300_000, genesisMs, seed = 7, players = 16 }) {
    const r = rng(seed)
    this.r = r
    this.players = Array.from({ length: players }, () => ({ id: fakeHex(r), fund: 3000 + Math.floor(r() * 9000), skill: r() }))
    const founders = [...BOTS.map((b) => ({ account_id: b.id, amount: E(b.fund) })), ...this.players.map((p) => ({ account_id: p.id, amount: E(p.fund) }))]
    this.engine = new MockEngine(mockConfig(nightMs), founders, genesisMs)
    this.planned = new Map() // night -> [{t, account, amount}] sorted by t
    this.done = new Map() // night -> index of the next unplayed throw
    this.overrides = new Map() // night -> plan (presets)
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
      if (b.kind === 'early' && r() < 0.9) out.push({ t: start + r() * 0.2 * nm, account: b.id, amount: jitter(b.amount) })
      if (b.kind === 'steady' && r() < 0.85) out.push({ t: start + (0.4 + r() * 0.4) * nm, account: b.id, amount: jitter(b.amount), cond: 'steady' })
      if (b.kind === 'late' && r() < 0.9) out.push({ t: start + (0.9 + r() * 0.09) * nm, account: b.id, amount: b.amount, cond: 'late' })
    }
    // A crowd that grows over the first nights, with some quiet nights.
    const crowd = Math.floor(r() * Math.min(9, 2 + n / 3))
    const picked = [...this.players].sort(() => r() - 0.5).slice(0, crowd)
    for (const p of picked) out.push({ t: start + r() * 0.97 * nm, account: p.id, amount: Math.max(5, Math.round((50 + r() * 900) / 5) * 5) })
    out.sort((a, b) => a.t - b.t)
    this.planned.set(n, out)
    return out
  }

  /** Plays every scheduled throw up to `now`. Each throw first settles ended nights, as a call would. */
  advance(now) {
    const e = this.engine
    for (let guard = 0; guard < 100_000; guard++) {
      const ev = this.nextEvent(now)
      if (!ev) break
      this.done.set(ev.n, ev.i + 1)
      e.catchUp(ev.item.t)
      if (e.night !== ev.n || !this.wants(ev.item)) continue
      const h = e.holders.get(ev.item.account)
      const amount = ev.item.units ?? E(ev.item.amount)
      if (h && h.balance >= amount) e.throw(ev.item.account, amount, ev.item.t)
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
    if (t.cond === 'late') {
      if (e.pile >= e.target) return true
      return e.pile * 10n >= e.target * 8n && e.pile + E(t.amount) >= e.target
    }
    return true
  }
}

// ---- presets for screenshots ----------------------------------------------------------------------

/**
 * scene: first (empty first visit), early, close (near the target, late), lit / smoke (a night that
 * just ended, so the page settles it and plays the outcome), live (a running world, the default).
 */
export function buildMock({ scene = 'live', nightMs = 300_000, now = Date.now(), me }) {
  const P = {
    first: { nights: 0, at: 0.05, pct: 0, crowd: 0, mine: null },
    early: { nights: 26, at: 0.12, pct: 0.17, crowd: 3, mine: { fund: 2350, wood: 0 } },
    close: { nights: 33, at: 0.86, pct: 0.9, crowd: 9, mine: { fund: 3100, wood: 800 } },
    lit: { nights: 39, at: 1.004, pct: 1.16, crowd: 11, mine: { fund: 4200, wood: 1500 } },
    smoke: { nights: 39, at: 1.004, pct: 0.64, crowd: 6, mine: { fund: 4200, wood: 700 } },
    live: { nights: 30, at: 0.3, pct: null, crowd: null, mine: { fund: 2600, wood: 0 } },
  }[scene] ?? null
  if (!P) throw new Error('unknown mock scene ' + scene)
  const n = P.nights + 1 // the open night
  const genesisMs = Math.floor(now - (P.nights + P.at) * nightMs)
  const world = new MockWorld({ nightMs, genesisMs })
  const e = world.engine
  const start = e.start(n)
  // History: let the schedule play until the open night begins. The player joined five nights ago.
  if (P.mine) {
    const joinNight = Math.max(1, n - 5)
    world.advance(e.start(joinNight) + 1000)
    e.catchUp(e.start(joinNight) + 1000)
    e.claimKindling(me, e.start(joinNight) + 1500)
    const extra = E(P.mine.fund) - big(e.cfg.kindling)
    if (extra > 0n) {
      // a gift from the idle bot stands in for rewards of earlier nights
      const giver = e.holders.get(BOTS[4].id)
      giver.balance -= extra
      e.holders.get(me).balance += extra
    }
    for (let k = joinNight; k < n; k++) {
      const plan = world.plan(k)
      plan.push({ t: e.start(k) + nightMs * (0.05 + 0.1 * ((k * 7) % 5)), account: me, amount: 150 + ((k * 37) % 4) * 100 })
      plan.sort((a, b) => a.t - b.t)
    }
  }
  world.advance(start - 1)
  e.catchUp(start + 1)
  // The open night: a crafted pile for the preset, or the normal schedule for `live`.
  if (P.pct !== null) {
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
      plan.push({ t: start + (r() * at * 0.9 + 0.01) * nightMs, account: acc, units: share })
    })
    if (mineWood > 0n) plan.push({ t: start + at * 0.35 * nightMs, account: me, units: mineWood })
    plan.sort((a, b) => a.t - b.t)
    for (const p of plan) if (p.units > 0n) e.throw(p.account, p.units, p.t)
    // After now: a few more throws keep the night alive on screen (not for the outcome presets).
    const later = []
    if (P.at < 1) {
      for (let k = 0; k < 4; k++) later.push({ t: now + (6 + k * 9 + r() * 6) * 1000, account: world.players[(k + 5) % world.players.length].id, amount: 40 + Math.round(r() * 200) })
    }
    world.overrides.set(n, later)
    // A night that just ended waits for the page to settle it: nobody else calls in the first seconds.
    if (P.at >= 1) world.overrides.set(n + 1, world.plan(n + 1).filter((x) => x.t > now + 8000))
  } else if (P.mine) {
    world.done.set(n, 0)
    world.advance(now)
  }
  return world
}

// ---- the client --------------------------------------------------------------------------------

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** Same surface as chain.js's Client, served from a MockWorld in this tab. */
export class MockClient {
  constructor({ scene = 'live', nightMs = 300_000, latency = 220 } = {}) {
    this.mock = true
    this.scene = scene
    this.nightMs = nightMs
    this.latency = latency
    this.contract = 'bonfire-coin.testnet'
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
  ftMetadata() {
    return this.call((e) => e.metadataView())
  }
  accessKeys() {
    return this.call(() => [])
  }
  viewAccount() {
    return this.call(() => ({ code_hash: 'mock: no code on chain' }))
  }

  record(kind, failure = null) {
    const entry = { kind, hash: fakeHash(this.r), gas: 2.4e12 + this.r() * 3e12, at: Date.now(), failure, mock: true }
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
    const a = JSON.parse(actionJson)
    const named = a.throw?.night ?? a.claim_kindling?.night
    const clock = e.clock(now)
    let res
    if (named !== clock) res = { error: `the action is for night ${named}, but this is night ${clock}` }
    else if (a.throw) res = e.throw(me, big(a.throw.amount), now)
    else if (a.claim_kindling) res = e.claimKindling(me, now)
    else res = { error: 'unknown action' }
    const h = e.holders.get(me)
    if (h) h.nonce += 1
    this.record('act')
    return { ok: !res.error, error: res.error ?? null, nonce: h?.nonce ?? 0, night: e.night, settled }
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
}

export { kindlingAction }
