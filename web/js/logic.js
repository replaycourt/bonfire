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

/** Base units with a fixed number of decimals, rounded down: "3,100,105.95", for ledger sums. */
export function fmtFixed(units, decimals, places = 2) {
  const u = big(units)
  const neg = u < 0n
  const a = neg ? -u : u
  const p = pow10(decimals)
  const frac = ((a % p) * 10n ** BigInt(places)) / p
  return (neg ? '-' : '') + group(a / p) + (places > 0 ? '.' + frac.toString().padStart(places, '0') : '')
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
  if (v >= 10 || Number.isInteger(v)) return '×' + Math.round(v)
  return '×' + (v < 1 ? v.toFixed(2).replace(/0$/, '') : v.toFixed(1).replace(/\.0$/, ''))
}

export const shortAccount = (a) => (a && a.length > 20 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a ?? '')

/**
 * A short name for an account on the page: implicit accounts as "a1b2…c3d4", named accounts by
 * their first label ("bot-early-a" for "bot-early-a.bonfire-stage.testnet"), "you" for the player,
 * and accounts in `labels` (the deployment's demo bots) by their label.
 */
export function nameOf(account, me, labels = {}) {
  if (!account) return ''
  if (account === me) return 'you'
  if (labels && Object.hasOwn(labels, account)) return labels[account]
  if (/^[0-9a-f]{64}$/.test(account)) return `${account.slice(0, 4)}…${account.slice(-4)}`
  const first = account.split('.')[0]
  return first.length > 18 ? `${first.slice(0, 16)}…` : first
}

// ---- the ritual's arithmetic (as in contract/src/math.rs and ritual.rs) --------------------------

/** The night the clock says is burning. Night 1 starts at genesis. */
export function clockNight(nowMs, genesisMs, nightMs) {
  return Math.floor(Math.max(0, nowMs - genesisMs) / nightMs) + 1
}

/** The window (0-based) that wood landing `elapsedMs` into a night falls in. */
export function windowAt(elapsedMs, nightMs, poolWindows) {
  const e = Math.min(Math.max(0, Math.floor(elapsedMs)), nightMs - 1)
  return Math.floor((e * poolWindows) / nightMs)
}

const mulDivCeil = (a, b, c) => (a * b + c - 1n) / c

/**
 * Weight of `below` units landing on a pile that already holds `before` (`before + below <= target`):
 * the pile-position factor falls linearly from `earlyMaxBp` on an empty pile to 10000 at the target.
 */
export function sliceWeight(target, earlyMaxBp, before, below) {
  const b = big(below)
  if (b === 0n) return 0n
  const em = BigInt(earlyMaxBp)
  return b * em - mulDivCeil(b * (em - BP), 2n * big(before) + b, 2n * big(target))
}

/**
 * Pooled windows: each window's wood covers the slice of the pile above all earlier windows; the
 * part below the target weighs its slice, the part above it `lateLitBp` per unit.
 * Returns [{ wood, start, weight }] in window order.
 */
export function windowWeights(woods, target, earlyMaxBp, lateLitBp) {
  const t = big(target)
  let start = 0n
  return woods.map((w) => {
    const x = big(w)
    const below = start >= t ? 0n : x < t - start ? x : t - start
    const weight = sliceWeight(t, earlyMaxBp, start, below) + (x - below) * BigInt(lateLitBp)
    const out = { wood: x, start, weight }
    start += x
    return out
  })
}

/** A thrower's weight: for each window, the window's weight times its wood there over the window's wood. */
export function weightOf(windowsW, woodByWindow) {
  let w = 0n
  for (const { window, wood } of woodByWindow ?? []) {
    const win = windowsW[window]
    if (win && win.wood > 0n) w += (win.weight * big(wood)) / win.wood
  }
  return w
}

/**
 * What `amount` thrown now would weigh if its window closed with it, as the contract's `estimate`
 * computes it: { night, window, amount, weight, factor_bp }.
 */
export function estimateLocal({ cfg, state, amount, nowMs }) {
  const c = cfg.config
  const pw = c.pool_windows
  const clock = clockNight(nowMs, Number(cfg.genesis_ms), Number(c.night_ms))
  const start = Number(cfg.genesis_ms) + (clock - 1) * Number(c.night_ms)
  const window = windowAt(nowMs - start, Number(c.night_ms), pw)
  const open = clock === state.night
  const woods = Array.from({ length: pw }, (_, i) => (open ? big(state.windows?.[i]?.wood) : 0n))
  let target = big(state.target)
  if (!open && target < big(c.target_min)) target = big(c.target_min)
  const a = big(amount)
  woods[window] += a
  const ws = windowWeights(woods, target, c.early_max_bp, c.late_lit_bp)
  const { wood: x, weight: w } = ws[window]
  const weight = x === 0n ? 0n : (w * a) / x
  return { night: clock, window, amount: a.toString(), weight: weight.toString(), factor_bp: a === 0n ? 0 : Number(weight / a) }
}

/** What a lit night mints and how it splits: { mint, cut, pool } (pool is owed to the throwers). */
export function lightPool({ target, mintBp, hearthCutBp, supply = 0n, supplyCap = null }) {
  let mint = (big(target) * BigInt(mintBp)) / BP
  if (supplyCap != null) {
    const room = big(supplyCap) - big(supply)
    if (mint > room) mint = room > 0n ? room : 0n
  }
  const cut = (mint * BigInt(hearthCutBp)) / BP
  return { mint, cut, pool: mint - cut }
}

/** A thrower's newly minted share if tonight catches, given the weights as they stand. */
export function expectedReward({ pool, myWeight, totalWeight }) {
  const w = big(myWeight)
  const total = big(totalWeight)
  if (w <= 0n || total <= 0n) return 0n
  return (big(pool) * w) / total
}

/** Wood a thrower loses if tonight smokes: the burned share, rounded as the contract rounds the return. */
export function smokeLoss({ wood, pile, smokeBp }) {
  const w = big(wood)
  const p = big(pile)
  if (w <= 0n || p <= 0n) return 0n
  const burn = (p * BigInt(smokeBp)) / BP
  return w - (w * (p - burn)) / p
}

// ---- signed actions -----------------------------------------------------------------------------

/** The exact text `act` expects a browser key to sign. */
export function signingText(contract, nonce, action) {
  return `bonfire:v1:${contract}:${nonce}:${action}`
}

export const throwAction = (amount, night) => JSON.stringify({ throw: { amount: big(amount).toString(), night } })
export const kindlingAction = (night) => JSON.stringify({ claim_kindling: { night } })
export const collectAction = (night) => JSON.stringify({ collect: { night } })

/** Nonces only have to rise. Milliseconds keep two tabs of one player from colliding. */
export function nextNonce(last, nowMs) {
  const n = Math.max(Number(last || 0) + 1, Math.floor(nowMs))
  if (n > Number.MAX_SAFE_INTEGER) throw new Error('nonce out of range')
  return n
}

// ---- choices ------------------------------------------------------------------------------------

const NICE = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000]

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

// ---- the night's windows, for the page -----------------------------------------------------------

/**
 * The night's windows as the page draws them: [{ window, wood, start, weight, factorBp, when,
 * startMs, endMs, mine }], `when` being 'past', 'now' or 'next'; plus the current window, when it
 * closes, and the factor a small throw would get in it now.
 */
export function windowsModel({ cfg, state, holder, nowMs }) {
  const c = cfg.config
  const pw = c.pool_windows
  const nightMs = Number(c.night_ms)
  const start = Number(state.night_start_ms)
  const due = nowMs >= Number(state.night_end_ms) || state.due
  const current = due ? pw : windowAt(nowMs - start, nightMs, pw)
  const target = big(state.target)
  const woods = Array.from({ length: pw }, (_, i) => big(state.windows?.[i]?.wood))
  const ws = windowWeights(woods, target, c.early_max_bp, c.late_lit_bp)
  const tonight = holder && holder.wood_night === state.night
  const mineBy = new Map((tonight ? holder.wood_by_window : []).map((w) => [w.window, big(w.wood)]))
  const segments = ws.map((w, i) => ({
    window: i,
    wood: w.wood,
    start: w.start,
    weight: w.weight,
    factorBp: w.wood > 0n ? Number(w.weight / w.wood) : null,
    when: i < current ? 'past' : i === current ? 'now' : 'next',
    startMs: start + Math.floor((nightMs * i) / pw),
    endMs: start + Math.floor((nightMs * (i + 1)) / pw),
    mine: mineBy.get(i) ?? 0n,
  }))
  // A small throw now: one whole EMBER added to the current window.
  let nowFactorBp = null
  if (!due) {
    const unit = 10n ** BigInt(c.decimals)
    const plus = [...woods]
    plus[current] += unit
    const after = windowWeights(plus, target, c.early_max_bp, c.late_lit_bp)[current]
    nowFactorBp = Number(after.weight / after.wood)
  }
  return { count: pw, current, due, segments, nowFactorBp, closesInMs: due ? 0 : Math.max(0, segments[current].endMs - nowMs), totalWeight: ws.reduce((s, w) => s + w.weight, 0n) }
}

// ---- the model the page renders -----------------------------------------------------------------

/**
 * Everything the page shows, from the contract's views.
 * cfg: config(); state: state(); holder: holder(me) or null; nowMs: the chain's clock as the
 * browser estimates it.
 */
export function deriveModel({ cfg, state, holder, nowMs }) {
  const c = cfg.config
  const dec = c.decimals
  const nightMs = Number(c.night_ms)
  const start = Number(state.night_start_ms)
  const end = Number(state.night_end_ms)
  const clock = clockNight(nowMs, Number(cfg.genesis_ms), nightMs)
  const due = state.due || nowMs >= end
  const pile = big(state.pile)
  const target = big(state.target)
  const pct = target > 0n ? Number((pile * 10_000n) / target) / 10_000 : 0
  const gap = target > pile ? target - pile : 0n
  const reached = pile >= target && pile > 0n
  const win = windowsModel({ cfg, state, holder, nowMs })

  const tonight = !!holder && holder.wood_night === state.night
  const balance = big(holder?.balance)
  const pending = big(holder?.pending)
  const myWood = tonight ? big(holder.wood) : 0n
  const myWeight = tonight ? big(holder.weight) : 0n
  const { pool, mint } = lightPool({ target, mintBp: c.mint_bp, hearthCutBp: c.hearth_cut_bp, supply: state.supply, supplyCap: cfg.supply_cap })
  const reward = expectedReward({ pool, myWeight, totalWeight: win.totalWeight })
  const loss = smokeLoss({ wood: myWood, pile, smokeBp: c.smoke_bp })

  const kindling = big(c.kindling)
  const hearth = big(state.hearth)
  let kindle
  if (holder && !holder.may_take_kindling) kindle = { can: false, why: holder.kindled ? 'claimed' : 'holder' }
  else if (hearth < kindling) kindle = { can: false, why: 'dry' }
  else if (state.kindling_left_tonight <= 0) kindle = { can: false, why: 'gone' }
  else if (holder && !holder.registered && state.accounts_sponsored >= state.max_accounts) kindle = { can: false, why: 'full' }
  else kindle = { can: true, why: '' }

  const minThrow = big(c.min_throw)
  const canThrow = balance >= minThrow && !due

  let phase = 'building'
  if (due) phase = 'due'
  else if (reached) phase = 'reached'
  else if (pile === 0n) phase = 'empty'
  else if (pct >= 0.75) phase = 'close'

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
    msLeft: Math.max(0, end - nowMs),
    progress: Math.min(1, Math.max(0, (nowMs - start) / nightMs)),
    pile,
    target,
    pct,
    gap,
    reached,
    windows: win,
    lateLitBp: c.late_lit_bp,
    earlyMaxBp: c.early_max_bp,
    throwers: state.throwers,
    firestarter: state.firestarter ?? null,
    lastLog: state.last_log ?? null,
    streak: state.streak,
    hearth,
    supply: big(state.supply),
    kindlingLeft: state.kindling_left_tonight,
    kindlingPerNight: c.kindling_per_night,
    kindling,
    kindle,
    balance,
    credited: big(holder?.credited),
    pending,
    readyNight: !tonight && pending > 0n ? holder.wood_night : null,
    myWood,
    myWeight,
    myWoodByWindow: tonight ? holder.wood_by_window : [],
    iThrew: myWood > 0n,
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

/**
 * What a throw would bring if tonight catches, from `estimate(amount)` (the contract's view, or
 * estimateLocal): the throw's weight and factor, and how much the player's share of the mint grows.
 * The totals are recomputed from tonight's windows with the amount added to the estimate's window.
 */
export function previewFromEstimate(m, est, cfg) {
  const c = cfg.config
  const a = big(est.amount)
  const k = est.window
  const segs = m.windows.segments
  // a throw for the next night (this one is due) lands on an empty pile
  const same = est.night === m.night
  const woods = segs.map((s) => (same ? s.wood : 0n))
  if (k < woods.length) woods[k] += a
  const after = windowWeights(woods, m.target, c.early_max_bp, c.late_lit_bp)
  const total = after.reduce((s, w) => s + w.weight, 0n)
  const mine = same ? (m.myWoodByWindow ?? []).map((w) => ({ window: w.window, wood: big(w.wood) })) : []
  const i = mine.findIndex((w) => w.window === k)
  if (i >= 0) mine[i] = { window: k, wood: mine[i].wood + a }
  else mine.push({ window: k, wood: a })
  const myAfter = weightOf(after, mine)
  const before = same ? expectedReward({ pool: m.pool, myWeight: m.myWeight, totalWeight: m.windows.totalWeight }) : 0n
  const reward = expectedReward({ pool: m.pool, myWeight: myAfter, totalWeight: total })
  return { amount: a, window: k, weight: big(est.weight), factorBp: est.factor_bp, reward, gain: reward > before ? reward - before : 0n }
}

/**
 * The hint under the throw buttons, from previewFromEstimate. When the player already holds all of
 * tonight's weight, more wood cannot grow its share of the mint, so the hint says what it does do.
 */
export function throwHint(m, amount, p) {
  const f = (u) => fmtEmber(u, m.dec)
  const head = `Throw ${f(amount)} now: it counts ${fmtFactor(p.factorBp)}`
  if (p.gain > 0n) return `${head}, about +${f(p.gain)} new ${m.symbol} if the fire catches.`
  if (m.myWeight > 0n && m.myWeight >= m.windows.totalWeight) return `${head}. Tonight's new ${m.symbol} is all yours so far; more wood helps the fire catch.`
  return `${head}. Too little to change your share of the new ${m.symbol}.`
}

/** The line beside "Collect": the credit already counts in the balance shown above it. */
export function readyText(m) {
  return `from night ${m.readyNight} is already in your balance. Collect it now, or your next throw will.`
}

/**
 * Why a newcomer gets no kindling now, in words. Kindling is capped per night, so a newcomer who
 * comes just after another is told when the next claim opens instead of "come back later".
 */
export function kindlingNote(why, msLeft) {
  if (why === 'gone') return `Tonight’s kindling is handed out. The next claim opens at dawn, in ${fmtCountdown(msLeft)}.`
  return { dry: 'The hearth has no kindling left.', full: 'The hearth pays for no more new accounts.', claimed: 'You have no free EMBER right now.', holder: 'You have no free EMBER right now.' }[why] ?? ''
}

/** One headline for the night: what tonight needs, in plain words. */
export function headline(m) {
  const sym = m.symbol
  if (m.due) return { big: 'Dawn', small: 'Lighting the fire…' }
  if (m.pile === 0n) return { big: `${fmtWhole(m.target, m.dec)} ${sym}`, small: 'of wood needed before dawn. Be the firestarter.' }
  if (m.reached) return { big: 'Enough wood', small: 'The fire catches at dawn.' }
  const gap = fmtWhole(m.gap, m.dec)
  return { big: `${gap === '0' ? 'Under 1' : gap} ${sym}`, small: 'more wood needed before dawn' }
}

// ---- a first visit, the streak at risk, the player's own tally ----------------------------------

/**
 * The three steps of a first night, as the intro lists them: get kindling, throw before dawn, see
 * the fire catch at dawn. Each step is 'done', 'now' or 'next'; `at` is the step the player is on.
 * `pendingWood` is wood thrown from this page that the views do not show yet.
 */
export function introSteps(m, pendingWood = 0n) {
  const threw = m.myWood + big(pendingWood) > 0n
  const has = threw || m.balance > 0n
  const at = !has ? 1 : !threw ? 2 : 3
  const kindle = !has && !m.kindle.can && m.kindle.why === 'gone' ? 'handed out tonight; the next claim opens at dawn' : 'free, no wallet, no sign-up'
  const steps = [
    { title: 'Get kindling', sub: kindle },
    { title: 'Throw before dawn', sub: 'early wood counts most' },
    { title: 'See it catch at dawn', sub: m.due ? 'dawn is breaking' : `dawn in ${fmtCountdown(m.msLeft)}` },
  ].map((s, i) => ({ ...s, n: i + 1, state: i + 1 < at ? 'done' : i + 1 === at ? 'now' : 'next' }))
  return { at, steps }
}

/**
 * Late in the night (its last quarter), with a streak running and the pile short of the target:
 * the line that says what dawn ends unless more wood lands. The wood is rounded up to whole EMBER,
 * since less would not be enough. Null at any other time.
 */
export function streakRisk(m) {
  if (!m || m.due || m.reached || !(m.streak > 0) || m.gap <= 0n) return null
  const w = m.windows
  if (!w || w.due || w.current < w.count - 1) return null
  const unit = pow10(m.dec)
  const need = (m.gap + unit - 1n) / unit
  const nights = m.streak === 1 ? '1 night' : `${m.streak} nights`
  return { streak: m.streak, need, text: `The streak of ${nights} ends at dawn unless ${fmtInt(need)} more wood lands.` }
}

// ---- the player's own dawn ----------------------------------------------------------------------

/**
 * The line under the player's wood once they have wood on tonight's pile, or a throw on its way:
 * the time to dawn and their wood, so they know when their result lands. `tab` is the same
 * countdown for the tab title while the tab is hidden. Null without wood tonight.
 */
export function dawnLine(m, pendingWood = 0n) {
  const wood = (m?.myWood ?? 0n) + big(pendingWood)
  if (!m || wood <= 0n) return null
  const w = fmtEmber(wood, m.dec)
  if (m.due) return { due: true, when: 'Dawn', what: `lighting the fire with your ${w} wood…`, tab: 'Dawn' }
  const left = fmtCountdown(m.msLeft)
  return { due: false, when: `Dawn in ${left}`, what: `your ${w} wood ${m.myWood > 0n ? 'on the pile' : 'on its way to the pile'}`, tab: `${left} to dawn` }
}

/**
 * The chime at the player's dawn: armed (with the night) while their wood waits for dawn, rung once
 * when that night's dawn comes, whether the clock shows it first or the settled state does. Wood
 * that never landed (a refused throw) disarms it without a sound.
 */
export function dawnCue(armed, night, dawn) {
  if (dawn && !dawn.due) return { armed: night, ring: false }
  if (armed != null && (dawn?.due || night > armed)) return { armed: null, ring: true }
  return { armed: dawn ? armed : null, ring: false }
}

/** The tab's title: the player's result or their countdown while the tab is hidden, else `base`. */
export function tabTitle(base, { hidden = false, dawn = null, result = null } = {}) {
  if (!hidden) return base
  if (result) return `${result} · ${base}`
  if (dawn) return `${dawn.tab} · ${base}`
  return base
}

/**
 * Who has played so far, as the contract counts it: its founders (the demo bots among them, as the
 * page labels them) and the accounts that claimed kindling. Kindling goes only to an account that
 * never held EMBER, so each claim is another account. Accounts that only received EMBER by transfer
 * are not counted. `meKindled`: the player is one of the claims.
 */
export function headcount({ founders = [], labels = {}, kindlingClaims = 0, meKindled = false }) {
  const ids = founders.map((f) => f?.account_id ?? f)
  const isBot = (a) => (labels && Object.hasOwn(labels, a)) || /^demo-bot-/.test(a)
  const bots = ids.filter(isBot).length
  const otherFounders = ids.length - bots
  const claims = Math.max(0, Number(kindlingClaims) || 0)
  const n = (k, one, many) => `${fmtInt(k)} ${k === 1 ? one : many}`
  const parts = []
  if (bots) parts.push(n(bots, 'labelled demo bot', 'labelled demo bots'))
  if (otherFounders) parts.push(n(otherFounders, 'other founding account', 'other founding accounts'))
  const mine = meKindled && claims > 0 ? (claims === 1 ? ': you' : ', you among them') : ''
  const other = otherFounders ? '' : 'other '
  const last = claims > 0 ? n(claims, `${other}account that claimed kindling`, `${other}accounts that claimed kindling`) + mine : parts.length ? 'no other account yet' : 'nobody yet'
  const text = `Players so far: ${parts.length ? `${parts.join(', ')} and ${last}` : last}`
  return { bots, otherFounders, claims, text }
}

/** How many of its nights the page keeps in a player's tally. */
export const TALLY_KEEP = 200

const tallyBy = (holder) => (holder.wood_by_window ?? []).map((w) => [Number(w.window), big(w.wood).toString()])

/**
 * The player's own tally, from what this page saw. The contract keeps no history per account, so
 * the page notes the wood of each night it sees in holder(me) and, once that night is settled and
 * not yet collected, what it pays (`pending`). `outcomeOf(n)` names a settled night's outcome where
 * the page knows it. Returns the tally: `{ nights: { [n]: { wood, by, out?, credit? } } }`, amounts
 * as decimal strings, so it can be kept as JSON.
 */
export function tallySee(tally, holder, openNight, outcomeOf = () => null) {
  const nights = { ...(tally?.nights ?? {}) }
  const n = holder?.wood_night
  if (n == null || big(holder.wood) <= 0n || nights[n]?.out) return { nights }
  const rec = { wood: big(holder.wood).toString(), by: tallyBy(holder) }
  if (n < openNight && big(holder.pending) > 0n) {
    const credit = big(holder.pending)
    rec.out = outcomeOf(n) ?? (credit >= big(holder.wood) ? 'LIT' : 'SMOKED')
    rec.credit = credit.toString()
  }
  nights[n] = rec
  const keep = Object.keys(nights).map(Number).sort((a, b) => b - a).slice(0, TALLY_KEEP)
  return { nights: Object.fromEntries(keep.map((k) => [k, nights[k]])) }
}

/** Settled nights in the tally whose payout the page has not seen, oldest first. */
export function tallyOpen(tally, openNight) {
  return Object.entries(tally?.nights ?? {})
    .filter(([n, r]) => Number(n) < openNight && !r.out)
    .map(([n]) => Number(n))
    .sort((a, b) => a - b)
}

/**
 * What a settled night credits wood thrown in it (`by`: [[window, wood]]), from night(n), as the
 * contract's credit_of computes it: on a lit night the wood plus its share of the throwers' mint by
 * weight, on a smoky night the wood's share of what the smoke left.
 */
export function creditFromNight(view, by) {
  const wood = (by ?? []).reduce((s, [, a]) => s + big(a), 0n)
  if (!view || wood === 0n) return wood
  if (view.outcome === 'LIT') {
    const ws = view.windows ?? []
    const total = ws.reduce((s, w) => s + big(w.weight), 0n)
    let mine = 0n
    for (const [i, a] of by) {
      const w = ws.find((x) => Number(x.window) === Number(i))
      if (w && big(w.wood) > 0n) mine += (big(w.weight) * big(a)) / big(w.wood)
    }
    const pool = big(view.minted) - big(view.hearth_cut)
    return wood + (total > 0n ? (pool * mine) / total : 0n)
  }
  if (view.outcome === 'SMOKED') {
    const pile = big(view.pile)
    const back = pile - (big(view.burned) - big(view.hearth_burned))
    return pile > 0n ? (wood * back) / pile : 0n
  }
  return wood
}

/**
 * Settles one night of the tally from night(n). Without the view (the contract keeps only the last
 * `log_keep` nights) the night keeps its outcome where known, and its payout stays unknown.
 */
export function tallyResolve(tally, n, view, outcome = null) {
  const nights = { ...(tally?.nights ?? {}) }
  const rec = nights[n]
  if (!rec || rec.out) return { nights }
  if (view && view.night === n && view.outcome !== 'OPEN') nights[n] = { ...rec, out: view.outcome, credit: creditFromNight(view, rec.by).toString() }
  else nights[n] = { ...rec, out: outcome ?? 'UNKNOWN', credit: null }
  return { nights }
}

/** The tally in one line, from its settled nights; null before the first of them. */
export function tallySummary(tally, decimals, symbol) {
  const rows = Object.values(tally?.nights ?? {}).filter((r) => r.out)
  if (!rows.length) return null
  let lit = 0
  let wood = 0n
  let earned = 0n
  let lost = 0n
  for (const r of rows) {
    const w = big(r.wood)
    wood += w
    if (r.out === 'LIT') lit++
    if (r.credit == null) continue
    const c = big(r.credit)
    if (c > w) earned += c - w
    else lost += w - c
  }
  const f = (u) => fmtEmber(u, decimals)
  const n = rows.length
  const head = lit === n ? `You helped light ${n === 1 ? 'a fire' : `${n} fires`}` : lit > 0 ? `You helped light ${lit} of ${n} fires` : n === 1 ? 'Your fire went up in smoke' : `Your ${n} fires went up in smoke`
  const parts = [head, `${f(wood)} wood thrown`]
  if (lit > 0) parts.push(`+${f(earned)} new ${symbol}`)
  if (lost > 0n) parts.push(`${f(lost)} burned`)
  return { nights: n, lit, wood, earned, lost, text: parts.join(' · ') }
}

// ---- outcomes and history -----------------------------------------------------------------------

/** "LIT ×4", "SMOKED", "COLD", as the coin's face writes them. */
export function outcomeWord(outcome, streak) {
  if (outcome === 'LIT') return `LIT ×${streak}`
  if (outcome === 'SMOKED' || outcome === 'COLD') return outcome
  return 'BURNING'
}

/** The last `count` settled nights for the strip, oldest first, each with the streak it reached. */
export function nightStrip(history, count) {
  let streak = 0
  const rows = (history ?? []).map((r) => {
    streak = r.outcome === 'LIT' ? streak + 1 : 0
    const target = big(r.target)
    const pile = big(r.pile)
    return {
      night: r.night,
      outcome: r.outcome,
      streak,
      word: outcomeWord(r.outcome, streak),
      target,
      pile,
      pct: target > 0n ? Number((pile * 1000n) / target) / 1000 : 0,
      minted: big(r.minted),
      burned: big(r.burned),
    }
  })
  return rows.slice(-count)
}

/** Supply after each settled night, as whole EMBER numbers for the chart. */
export function supplySeries(history, decimals) {
  return (history ?? []).map((r) => ({ night: r.night, supply: toWhole(r.supply, decimals), outcome: r.outcome }))
}

/**
 * What each of the last `count` settled nights did to the supply, for the chart: EMBER minted (a lit
 * night) and burned (smoke, and the hearth's share), in whole EMBER, with the streak it reached.
 */
export function flowSeries(history, decimals, count = 60) {
  let streak = 0
  return (history ?? [])
    .map((r) => {
      streak = r.outcome === 'LIT' ? streak + 1 : 0
      return { night: r.night, outcome: r.outcome, word: outcomeWord(r.outcome, streak), streak, mint: toWhole(r.minted, decimals), burn: toWhole(r.burned, decimals), supply: toWhole(r.supply, decimals) }
    })
    .slice(-count)
}

/** `from` for history(): the oldest of the last `count` settled nights. */
export function historyFrom(openNight, count) {
  return Math.max(1, openNight - count)
}

// ---- the ledger: every mint and burn ------------------------------------------------------------

/**
 * One ledger row per settled night, newest first. `rows` are history rows, oldest first and without
 * gaps; `details` maps a night to its night() view where the page has one (the contract keeps the
 * last `log_keep`), which splits the mint into the throwers' part and the hearth's cut and the burn
 * into pile smoke and hearth burn, and gives the exact streak. A LIT row's streak is only counted
 * when the rows reach back to a night that was not LIT, or to `firstNight`, the oldest night kept.
 */
export function ledgerRows(rows, details = new Map(), firstNight = 1) {
  const out = []
  let streak = 0
  let known = rows.length > 0 && rows[0].night <= firstNight
  for (const r of rows) {
    const d = details.get(r.night) ?? null
    if (r.outcome === 'LIT') streak++
    else {
      streak = 0
      known = true
    }
    const minted = big(r.minted)
    const burned = big(r.burned)
    const hearthCut = d && r.outcome === 'LIT' ? big(d.hearth_cut) : null
    const hearthBurn = d && r.outcome !== 'LIT' ? big(d.hearth_burned) : null
    const count = d ? d.streak : known ? streak : null
    out.push({
      night: r.night,
      outcome: r.outcome,
      word: r.outcome === 'LIT' ? (count ? `LIT ×${count}` : 'LIT') : r.outcome,
      target: big(r.target),
      pile: big(r.pile),
      minted,
      burned,
      hearthCut,
      shared: hearthCut === null ? null : minted - hearthCut,
      hearthBurn,
      pileBurn: hearthBurn === null ? null : burned - hearthBurn,
      supply: big(r.supply),
    })
  }
  return out.reverse()
}

/**
 * The books in one line: genesis + everything minted - everything burned must be the supply.
 * From config() and state() alone, so the page can show it without loading every night.
 */
export function ledgerCheck(cfg, state) {
  const genesis = big(cfg.genesis_supply)
  const minted = big(state.records?.total_minted)
  const burned = big(state.records?.total_burned)
  const supply = big(state.supply)
  return { genesis, minted, burned, supply, ok: genesis + minted - burned === supply }
}

/** The history() call for the page of `size` nights before `oldest` (the oldest night loaded). */
export function olderPage(oldest, size) {
  const from = Math.max(1, oldest - size)
  return { from, limit: Math.max(0, oldest - from) }
}

/** Joins loaded history rows into one list, oldest first, each night once. */
export function mergeHistory(...lists) {
  const by = new Map()
  for (const list of lists) for (const r of list ?? []) by.set(r.night, r)
  return [...by.values()].sort((a, b) => a.night - b.night)
}

/**
 * A settled night in words, for the banner. `holder` is the player's holder view read after the
 * settle: while its wood is from that night and uncollected, `pending` is what the night owes it.
 */
export function nightResult(nightView, holder, me, decimals, symbol, labels = {}) {
  if (!nightView) return null
  const f = (u) => fmtEmber(u, decimals)
  const outcome = nightView.outcome
  const r = {
    night: nightView.night,
    outcome,
    word: outcomeWord(outcome, nightView.streak),
    target: big(nightView.target),
    pile: big(nightView.pile),
    minted: big(nightView.minted),
    shared: big(nightView.minted) - big(nightView.hearth_cut),
    burned: big(nightView.burned),
    throwers: nightView.throwers ?? 0,
    firestarter: nightView.firestarter ?? null,
    lastLog: nightView.last_log ?? null,
    mine: null,
  }
  if (holder && holder.wood_night === r.night && big(holder.pending) > 0n) {
    const wood = big(holder.wood)
    const credit = big(holder.pending)
    r.mine = { wood, credit, reward: credit > wood ? credit - wood : 0n, lost: wood > credit ? wood - credit : 0n }
  }
  const names = [r.firestarter && `Firestarter: ${nameOf(r.firestarter, me, labels)}`, r.lastLog && `Last log: ${nameOf(r.lastLog.account, me, labels)} (${f(r.lastLog.amount)})`].filter(Boolean)
  r.names = names.join(' · ')
  if (outcome === 'LIT') {
    r.title = 'The fire caught!'
    r.text = r.mine
      ? `Your ${f(r.mine.wood)} wood comes back, plus ${f(r.mine.reward)} new ${symbol}.`
      : `${r.throwers} thrower${r.throwers === 1 ? '' : 's'} shared ${f(r.shared)} new ${symbol}.`
  } else if (outcome === 'SMOKED') {
    r.title = 'Up in smoke'
    r.text = r.mine
      ? `${f(r.mine.credit)} of your ${f(r.mine.wood)} wood comes back; ${f(r.mine.lost)} burned.`
      : `${fmtWhole(r.pile, decimals)} of ${fmtWhole(r.target, decimals)} wood was not enough. ${f(r.burned)} ${symbol} burned.`
  } else {
    r.title = 'A cold night'
    r.text = 'Nobody brought wood. Nothing burned; the target shrinks.'
  }
  return r
}

// ---- people around the fire ---------------------------------------------------------------------

/**
 * The moon's path across the night, in stage pixels: it keeps to the side of the sky, right of the
 * clock and the rules and, on wide screens, above "Your wood", so it never passes behind text, a card,
 * the banner or the fire. `text` is the sky text's rect and `card` the right-hand card's (null on
 * phones, where the cards sit under the scene), both relative to the stage; `top` is the header's
 * lowest point and `r` the moon's radius. The moon rises by `lift` at midnight.
 */
export function moonPath({ W, H, text = null, card = null, top = 60, r = 20 }) {
  if (!card) {
    // phones: under the sky text, at the right edge, clear of the fire and the target's label
    const y = Math.min(Math.max(H * 0.42, (text?.bottom ?? 0) + r + 16), H * 0.62)
    return { x0: W * 0.82, x1: Math.max(W * 0.82, W * 0.95 - r), y, lift: 0 }
  }
  const x0 = Math.min(Math.max(W * 0.74, (text?.right ?? 0) + r + 24), W - r - 16)
  const x1 = Math.max(x0, Math.min(W * 0.9, card.right - r - 12))
  const room = Math.max(0, card.top - top)
  return { x0, x1, y: top + room / 2, lift: Math.max(0, Math.min(H * 0.03, room / 2 - r - 10)) }
}

/**
 * Longest random wait before a page settles at dawn, so that open pages do not all send `settle`. A
 * settle takes a second or two to show in the views; a much shorter spread would keep every page in
 * the race.
 */
export const SETTLE_JITTER_MS = 5000
export const settleDelay = (random = Math.random) => Math.floor(Math.min(0.999999, Math.max(0, random())) * SETTLE_JITTER_MS)

/**
 * Settle only while the chain itself says a night is due (another page or a bot may have settled),
 * and only from a tab someone is looking at: a hidden tab settles when it is shown again, if still due.
 */
export const settleNeeded = (state, hidden = false) => !hidden && Number(state?.nights_due ?? 0) > 0

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
 * Tonight's throwers as far as the page can name them: the accounts in `recent_throws` for this
 * night with their wood, and the player if it has wood on the pile.
 */
export function throwersFromRecent(recent, night, me, myWood = 0n) {
  const by = new Map()
  for (const t of recent ?? []) {
    if (t.night !== night) continue
    by.set(t.account, (by.get(t.account) ?? 0n) + big(t.amount))
  }
  if (me && big(myWood) > 0n) by.set(me, big(myWood))
  return [...by].map(([account, wood]) => ({ account, wood }))
}

/**
 * Seats around the fire: the player first, then the biggest wood. At most `max`; `more` counts
 * the throwers not shown (the night may have more than the page can name).
 */
export function seats(throwers, me, max, total = throwers?.length ?? 0) {
  const list = [...(throwers ?? [])]
    .map((t) => ({ account: t.account, wood: big(t.wood), me: t.account === me, seed: hashSeed(t.account) }))
    .sort((a, b) => (a.me !== b.me ? (a.me ? -1 : 1) : a.wood === b.wood ? 0 : a.wood > b.wood ? -1 : 1))
  const shown = list.slice(0, max)
  return { shown, more: Math.max(0, Math.max(total, list.length) - shown.length) }
}

/** A stable key for one recent throw, to spot new ones between polls. */
export const throwKey = (t) => `${t.night}:${t.at_ms}:${t.account}:${t.amount}`

/**
 * Throwers of settled nights the page can help collect: accounts in `recent_throws` whose night is
 * settled, not the player, not tried before; newest first, at most `max`.
 */
export function collectCandidates(recent, openNight, me, tried, max) {
  const out = []
  for (const t of [...(recent ?? [])].reverse()) {
    if (out.length >= max) break
    if (t.night >= openNight || t.account === me || tried.has(t.account) || out.includes(t.account)) continue
    out.push(t.account)
  }
  return out
}

/**
 * One round of collecting for other throwers: checks the candidates in order, skips those already
 * collected (their bots or their own next move did it), and relays at most `max` collections.
 * Stops at the first error. Returns how many it relayed.
 */
export async function helpCollectRound({ candidates, tried, max, pendingOf, collect, onError }) {
  let done = 0
  for (const account of candidates) {
    if (done >= max) break
    tried.add(account)
    try {
      if ((await pendingOf(account)) <= 0n) continue
      await collect(account)
      done++
    } catch (e) {
      onError?.(account, e)
      break
    }
  }
  return done
}

/** Is a metadata icon safe to show in an <img>? Only SVG data URLs. */
export function safeIcon(icon) {
  return typeof icon === 'string' && /^data:image\/svg\+xml[,;]/.test(icon) && icon.length < 20_000 ? icon : null
}

// ---- first visit, dawn, sound ---------------------------------------------------------------------

/**
 * localStorage that never throws: reading gives null and writing does nothing where the browser
 * refuses it (private windows, blocked site data). `getStorage` is called inside the try, since
 * merely touching `localStorage` can throw.
 */
export function safeStore(getStorage) {
  const s = () => {
    try {
      return typeof getStorage === 'function' ? getStorage() : getStorage
    } catch {
      return null
    }
  }
  return {
    get(k) {
      try {
        return s()?.getItem(k) ?? null
      } catch {
        return null
      }
    },
    set(k, v) {
      try {
        s()?.setItem(k, String(v))
        return !!s()
      } catch {
        return false
      }
    },
  }
}

/**
 * Last night plays back once per browser: on a first visit (`seen` is the stored flag), with motion
 * allowed, for a settled night that caught or smoked with wood on it, before the open night.
 */
export function replayWanted({ seen = null, reduced = false, last = null, night = null }) {
  if (seen || reduced || !last || !['LIT', 'SMOKED'].includes(last.outcome)) return false
  if (big(last.pile) <= 0n || big(last.target) <= 0n) return false
  return night == null || Number(last.night) < Number(night)
}

/** The stamp in the sky at dawn: the word the coin's face writes for the night. */
export function stampFor(outcome, word = '') {
  if (outcome === 'LIT') return { text: /^LIT ×\d+$/.test(word ?? '') ? word : 'LIT', kind: 'lit' }
  if (outcome === 'SMOKED') return { text: 'SMOKED', kind: 'smoked' }
  if (outcome === 'COLD') return { text: 'COLD', kind: 'cold' }
  return null
}

/** Sound comes on with the first tap on "Get kindling", unless the player chose on or off before. */
export const soundOnFirstTap = (choice) => choice !== 'on' && choice !== 'off'
