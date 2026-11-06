// Pure logic of the page: units and formatting, the ritual's arithmetic (mirroring the contract, in
// BigInt), the signed action format, and the model the UI renders, derived from the contract's views.
// No DOM, no network: everything here runs in Node for the unit tests.

export const BP = 10_000n

// ---- units and formatting ----------------------------------------------------------------------

export const big = (v) => (typeof v === 'bigint' ? v : BigInt(v ?? 0))
const pow10 = (d) => 10n ** BigInt(d)

/** Whole EMBER (number or decimal string) to base units. */
export function toUnits(whole, decimals) {
  const s = String(whole)
  const [i, f = ''] = s.split('.')
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals)
  return BigInt(i || '0') * pow10(decimals) + BigInt(frac || '0')
}

/** Base units to a JS number of whole EMBER (for charts and ratios; display uses fmtEmber). */
export function toWhole(units, decimals) {
  const u = big(units)
  const p = pow10(decimals)
  return Number(u / p) + Number(u % p) / Number(p)
}

const group = (n) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')

export function fmtInt(n) {
  const v = typeof n === 'bigint' ? n : BigInt(Math.round(Number(n) || 0))
  return (v < 0n ? '-' : '') + group(v < 0n ? -v : v)
}

/**
 * Base units as EMBER text: grouped whole numbers, with up to two decimals below 1,000 and one
 * significant digit for dust ("0.004"). `compact` gives 1.2k / 3.4M for tight spots.
 */
export function fmtEmber(units, decimals, { compact = false, sign = false } = {}) {
  const u = big(units)
  const neg = u < 0n
  const a = neg ? -u : u
  const p = pow10(decimals)
  const whole = a / p
  let text
  if (compact && whole >= 10_000n) {
    const n = toWhole(a, decimals)
    const [div, suf] = n >= 1e9 ? [1e9, 'B'] : n >= 1e6 ? [1e6, 'M'] : [1e3, 'k']
    const v = n / div
    text = (v >= 100 ? Math.floor(v).toString() : (Math.floor(v * 10) / 10).toFixed(1).replace(/\.0$/, '')) + suf
  } else if (whole >= 1000n || decimals === 0) {
    text = group(whole)
  } else {
    const frac = a % p
    const hundredths = (frac * 100n) / p
    if (whole === 0n && hundredths === 0n && frac > 0n) {
      const s = frac.toString().padStart(decimals, '0')
      const first = s.search(/[1-9]/)
      text = '0.' + s.slice(0, first + 1)
    } else {
      text = group(whole) + (hundredths ? '.' + hundredths.toString().padStart(2, '0').replace(/0$/, '') : '')
    }
  }
  return (neg ? '-' : sign && a > 0n ? '+' : '') + text
}

/** Base units as whole EMBER, rounded down and grouped: for piles and targets. */
export function fmtWhole(units, decimals) {
  return group(big(units) / pow10(decimals))
}

/** Time left as m:ss below an hour, h:mm:ss below a day, "2d 03h" beyond. */
export function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const two = (n) => String(n).padStart(2, '0')
  if (d > 0) return `${d}d ${two(h)}h`
  if (h > 0) return `${h}:${two(m)}:${two(sec)}`
  return `${m}:${two(sec)}`
}

/** A night length in words: "5 minutes", "1 day", "90 seconds". */
export function fmtDuration(ms) {
  const units = [
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
    [1000, 'second'],
  ]
  for (const [size, name] of units) {
    if (ms >= size && ms % size === 0) {
      const n = ms / size
      return `${n} ${name}${n === 1 ? '' : 's'}`
    }
  }
  return `${Math.round(ms / 1000)} seconds`
}

/** Basis points as a percentage: 700 -> "7 %", 25 -> "0.25 %". */
export function fmtPct(bp) {
  const v = Number(bp) / 100
  return `${Number.isInteger(v) ? v : v.toFixed(2).replace(/0$/, '')} %`
}

/** Basis points of weight as a factor: 60000 -> "×6", 45250 -> "×4.5". */
export function fmtFactor(bp) {
  const v = Number(bp) / 10_000
  return '×' + (v >= 10 || Number.isInteger(v) ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, ''))
}

export const shortAccount = (a) => (a && a.length > 20 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a ?? '')

// ---- the ritual's arithmetic (as in the contract) -----------------------------------------------

/** The night the clock says is burning. Night 1 starts at genesis. */
export function clockNight(nowMs, genesisMs, nightMs) {
  return Math.floor(Math.max(0, nowMs - genesisMs) / nightMs) + 1
}

/** Early factor in bp for wood landing `elapsedMs` into a night (rounded up for the thrower). */
export function earlyBp(elapsedMs, nightMs, earlyMaxBp) {
  const span = BigInt(earlyMaxBp - 10_000)
  const elapsed = BigInt(Math.max(0, Math.min(Math.floor(elapsedMs), nightMs)))
  return earlyMaxBp - Number((span * elapsed) / BigInt(nightMs))
}

/** Weight of a throw: the part below the target counts early, the part above it counts late. */
export function throwWeight({ amount, pile, target, earlyBp: early, lateLitBp }) {
  const a = big(amount)
  const p = big(pile)
  const t = big(target)
  const room = t > p ? t - p : 0n
  const below = a < room ? a : room
  return below * BigInt(early) + (a - below) * BigInt(lateLitBp)
}

/** What a lit night mints and how it splits: { mint, cut, pool } (pool goes to the throwers). */
export function lightPool({ target, mintBp, hearthCutBp, supply = 0n, supplyCap = null }) {
  let mint = (big(target) * BigInt(mintBp)) / BP
  if (supplyCap != null) {
    const room = big(supplyCap) - big(supply)
    if (mint > room) mint = room > 0n ? room : 0n
  }
  const cut = (mint * BigInt(hearthCutBp)) / BP
  return { mint, cut, pool: mint - cut }
}

/** A thrower's newly minted share if tonight catches, given tonight's weights as they stand. */
export function expectedReward({ pool, myWeight, totalWeight }) {
  const w = big(myWeight)
  const total = big(totalWeight)
  if (w <= 0n || total <= 0n) return 0n
  return (big(pool) * w) / total
}

/** Wood a thrower loses if tonight goes up in smoke (the burned share, rounded as the contract does). */
export function smokeLoss({ wood, pile, smokeBp }) {
  const w = big(wood)
  const p = big(pile)
  if (w <= 0n || p <= 0n) return 0n
  const burn = (p * BigInt(smokeBp)) / BP
  const back = ((p - burn) * w) / p
  return w - back
}

// ---- signed actions -----------------------------------------------------------------------------

/** The exact text `act` expects a browser key to sign. */
export function signingText(contract, nonce, action) {
  return `bonfire:v1:${contract}:${nonce}:${action}`
}

export const throwAction = (amount, night) => JSON.stringify({ throw: { amount: big(amount).toString(), night } })
export const kindlingAction = (night) => JSON.stringify({ claim_kindling: { night } })

/** Nonces only have to rise. Milliseconds keep two tabs of one player from colliding. */
export function nextNonce(last, nowMs) {
  const n = Math.max(Number(last || 0) + 1, Math.floor(nowMs))
  if (n > Number.MAX_SAFE_INTEGER) throw new Error('nonce out of range')
  return n
}

// ---- choices ------------------------------------------------------------------------------------

const NICE = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000]

function niceBelow(x) {
  let best = 0
  for (const n of NICE) if (n <= x) best = n
  return best
}

/**
 * Throw buttons for a balance: up to three round amounts (about an eighth, a quarter and a half of
 * the balance) and "All". Amounts are base units. Nothing below `minThrow`.
 */
export function throwChoices(balance, decimals, minThrow = 1n) {
  const b = big(balance)
  const min = big(minThrow)
  if (b <= 0n || b < min) return []
  const whole = toWhole(b, decimals)
  const picks = []
  for (const f of [1 / 8, 1 / 4, 1 / 2]) {
    const n = niceBelow(whole * f)
    if (n <= 0) continue
    const units = toUnits(n, decimals)
    if (units < min || units >= b) continue
    if (!picks.some((p) => p.amount === units)) picks.push({ label: fmtInt(n), amount: units, all: false })
  }
  picks.push({ label: 'All', amount: b, all: true })
  return picks
}

// ---- the model the page renders -----------------------------------------------------------------

/**
 * Everything the page shows, from the contract's views.
 * cfg: config(); state: state(); holder: holder(me) or null; tonight: night(state.night) or null;
 * nowMs: the chain's clock as the browser estimates it.
 */
export function deriveModel({ cfg, state, holder, tonight, nowMs }) {
  const c = cfg.config
  const dec = c.decimals
  const nightMs = Number(c.night_ms)
  const start = Number(state.night_start_ms)
  const end = Number(state.night_end_ms)
  const clock = clockNight(nowMs, Number(cfg.genesis_ms), nightMs)
  const due = state.due || nowMs >= end
  const msLeft = Math.max(0, end - nowMs)
  const progress = Math.min(1, Math.max(0, (nowMs - start) / nightMs))
  const pile = big(state.pile)
  const target = big(state.target)
  const pct = target > 0n ? Number((pile * 10_000n) / target) / 10_000 : 0
  const gap = target > pile ? target - pile : 0n
  const reached = pile >= target && pile > 0n
  // The factor new wood would get right now: early below the target, late above it.
  const early = earlyBp(Math.max(0, nowMs - start), nightMs, c.early_max_bp)
  const newWoodBp = reached ? c.late_lit_bp : early

  const balance = big(holder?.balance)
  const myWood = big(holder?.wood)
  const myWeight = big(holder?.weight)
  const totalWeight = big(state.weight)
  const { pool, mint } = lightPool({ target, mintBp: c.mint_bp, hearthCutBp: c.hearth_cut_bp, supply: state.supply, supplyCap: cfg.supply_cap })
  const reward = expectedReward({ pool, myWeight, totalWeight })
  const loss = smokeLoss({ wood: myWood, pile, smokeBp: c.smoke_bp })

  const kindling = big(c.kindling)
  const hearth = big(state.hearth)
  let kindle = { can: false, why: '' }
  if (holder && !holder.may_take_kindling) kindle = { can: false, why: holder.kindled ? 'claimed' : 'holder' }
  else if (hearth < kindling) kindle = { can: false, why: 'dry' }
  else if (state.kindling_left_tonight <= 0) kindle = { can: false, why: 'gone' }
  else if (holder && !holder.registered && state.accounts_sponsored >= state.max_accounts) kindle = { can: false, why: 'full' }
  else kindle = { can: true, why: '' }

  const seatTaken = myWood > 0n
  const seatsLeft = Math.max(0, state.max_throwers - state.throwers)
  const minThrow = big(c.min_throw)
  const canThrow = balance >= minThrow && (seatTaken || seatsLeft > 0) && !due

  let phase = 'building'
  if (due) phase = 'due'
  else if (reached) phase = 'reached'
  else if (pile === 0n) phase = 'empty'
  else if (pct >= 0.75) phase = 'close'

  const throwers = (tonight?.throwers ?? []).map((t) => ({ account: t.account, wood: big(t.wood), weight: big(t.weight) }))

  return {
    dec,
    symbol: c.symbol,
    night: state.night,
    clock,
    due,
    nightsDue: Math.max(state.nights_due, clock - state.night),
    start,
    end,
    nightMs,
    msLeft,
    progress,
    pile,
    target,
    pct,
    gap,
    reached,
    earlyBp: early,
    newWoodBp,
    lateLitBp: c.late_lit_bp,
    earlyMaxBp: c.early_max_bp,
    throwers: state.throwers,
    throwerList: throwers,
    maxThrowers: state.max_throwers,
    seatsLeft,
    streak: state.streak,
    hearth,
    supply: big(state.supply),
    kindlingLeft: state.kindling_left_tonight,
    kindlingPerNight: c.kindling_per_night,
    kindling,
    kindle,
    balance,
    myWood,
    myWeight,
    totalWeight,
    iThrew: seatTaken,
    mint,
    pool,
    reward,
    loss,
    canThrow,
    minThrow,
    choices: throwChoices(balance, dec, minThrow),
    phase,
    records: state.records,
    last: state.last ?? null,
  }
}

/** What a throw of `amount` now would add to the thrower's share if the night catches. */
export function throwPreview(m, amount) {
  const a = big(amount)
  const weight = throwWeight({ amount: a, pile: m.pile, target: m.target, earlyBp: m.earlyBp, lateLitBp: m.lateLitBp })
  // A throw that lifts the pile over the target makes the night catch: the pool is what counts.
  const before = expectedReward({ pool: m.pool, myWeight: m.myWeight, totalWeight: m.totalWeight })
  const after = expectedReward({ pool: m.pool, myWeight: m.myWeight + weight, totalWeight: m.totalWeight + weight })
  return { amount: a, weight, reward: after, gain: after - before }
}

/** One headline for the scene: what tonight needs, in plain words. */
export function headline(m) {
  const sym = m.symbol
  if (m.due) return { big: 'Dawn', small: 'Lighting the fire…' }
  if (m.pile === 0n) return { big: `${fmtWhole(m.target, m.dec)} ${sym}`, small: 'of wood needed before dawn. Be the first.' }
  if (m.reached) return { big: 'Enough wood', small: 'The fire catches at dawn.' }
  const gap = fmtWhole(m.gap, m.dec)
  return { big: `${gap === '0' ? 'Under 1' : gap} ${sym}`, small: 'more wood needed before dawn' }
}

// ---- history ------------------------------------------------------------------------------------

/** The last `count` settled nights for the strip, oldest first. */
export function nightStrip(history, count) {
  return (history ?? []).slice(-count).map((r) => {
    const target = big(r.target)
    const pile = big(r.pile)
    return {
      night: r.night,
      outcome: r.outcome,
      target,
      pile,
      pct: target > 0n ? Number((pile * 1000n) / target) / 1000 : 0,
      minted: big(r.minted),
      burned: big(r.burned),
    }
  })
}

/** Supply after each settled night, as whole EMBER numbers for the chart. */
export function supplySeries(history, decimals) {
  return (history ?? []).map((r) => ({ night: r.night, supply: toWhole(r.supply, decimals), outcome: r.outcome }))
}

/** `from` for history(): the oldest of the last `count` settled nights. */
export function historyFrom(openNight, count) {
  return Math.max(1, openNight - count)
}

/** The player's line in a settled night's log, turned into words. */
export function nightResult(nightView, me, decimals, symbol) {
  if (!nightView) return null
  const outcome = nightView.outcome
  const mine = (nightView.throwers ?? []).find((t) => t.account === me)
  const r = {
    night: nightView.night,
    outcome,
    target: big(nightView.target),
    pile: big(nightView.pile),
    minted: big(nightView.minted),
    shared: big(nightView.minted) - big(nightView.hearth_cut),
    burned: big(nightView.burned),
    throwers: (nightView.throwers ?? []).length,
    mine: null,
  }
  if (mine) {
    r.mine = { wood: big(mine.wood), back: big(mine.back), reward: big(mine.reward), lost: big(mine.lost) }
  }
  const f = (u) => fmtEmber(u, decimals)
  if (outcome === 'lit') {
    r.title = `Night ${r.night} caught fire`
    r.text = r.mine
      ? `Your ${f(r.mine.wood)} wood came back, plus ${f(r.mine.reward)} new ${symbol}.`
      : `${r.throwers} thrower${r.throwers === 1 ? '' : 's'} shared ${f(r.shared)} new ${symbol}.`
  } else if (outcome === 'smoke') {
    r.title = `Night ${r.night} went up in smoke`
    r.text = r.mine
      ? `${f(r.mine.back)} of your ${f(r.mine.wood)} wood came back; ${f(r.mine.lost)} burned.`
      : `${f(r.pile)} of ${f(r.target)} wood was not enough. ${f(r.burned)} ${symbol} burned.`
  } else {
    r.title = `Night ${r.night} stayed cold`
    r.text = `Nobody brought wood. The hearth lost ${f(r.burned)} ${symbol}.`
  }
  return r
}

// ---- people around the fire ---------------------------------------------------------------------

/** A small stable hash of a string, for seeding a silhouette's look. */
export function hashSeed(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * Seats around the fire: tonight's throwers (biggest wood nearest the fire), the player first among
 * equals. Returns at most `max`, plus how many more there are.
 */
export function seats(throwers, me, max) {
  const list = [...(throwers ?? [])]
    .map((t) => ({ account: t.account, wood: big(t.wood), me: t.account === me, seed: hashSeed(t.account) }))
    .sort((a, b) => (a.me !== b.me ? (a.me ? -1 : 1) : a.wood === b.wood ? 0 : a.wood > b.wood ? -1 : 1))
  return { shown: list.slice(0, max), more: Math.max(0, list.length - max) }
}

/** Is a metadata icon safe to show in an <img>? Only SVG data URLs. */
export function safeIcon(icon) {
  return typeof icon === 'string' && /^data:image\/svg\+xml[,;]/.test(icon) && icon.length < 20_000 ? icon : null
}
