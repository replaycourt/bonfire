#!/usr/bin/env node
// The five demo bots of the testnet variant (sim/params.json, testnet.demo_bots; docs/SIMULATION.md,
// "Testnet variant"). They are founders and clearly labelled as bots; they follow fixed, published
// strategies and do not react to people. Every action is an `act` signed by the bot's own key and
// relayed through the gas account's function-call keys; `settle` and `collect` go through the
// same keys.
//
//   node scripts/bots.mjs <contract> --nights <N> [--seed <s>] [--always] [--smoke <k,...>]
//                         [--cold <k,...>] [--quiet <k,...>]
//
// --nights N   play N nights, then settle, collect and exit (never runs forever)
// --seed s     the bots' random streams (default 1)
// --always     every bot plays every night it may (drops the 85-90 % chance to play)
// --smoke k    on the run's k-th night the bots under-throw on purpose so it SMOKES: the early bots
//              throw a quarter of their usual wood, the steady and late bots hold back
// --cold k     on the run's k-th night nobody throws (it settles COLD); settle and collect still run
// --quiet k    on the run's k-th night the bots do nothing at all, not even settle, so the next
//              night's first call settles two nights at once (catch-up)
//
// Behaviours, as in sim/bonfire_sim.py (bot_early, bot_steady, bot_late, bot_idle):
// - demo-bot-early-a / -b: 90 % of nights, in the first fifth of the night, about 200 / 150 EMBER
//   (plus or minus 25 %);
// - demo-bot-steady: 85 % of nights, between 40 % and 80 % of the night, about 150 EMBER, only if
//   the streak is at least 2 or the pile is at 60 % of the target;
// - demo-bot-late: 90 % of nights, in the last tenth, 100 EMBER, only if the fire is already safe
//   (late_lit > 0) or the pile is at 80 % of the target and 100 EMBER close the gap; it sends at
//   least 12 s before the night ends, so that the transaction lands on the night it names;
// - demo-bot-idle: never throws.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tgas, view } from './near-lite.mjs'
import { BP, ROOT, Relay, ember, loadBots, readJson, sleep, throwEvent } from './bonfire-lib.mjs'

export const BEHAVIOURS = {
  'demo-bot-early-a': { logic: 'plain', p: 0.9, t: [0.0, 0.2], f: [0.75, 1.25] },
  'demo-bot-early-b': { logic: 'plain', p: 0.9, t: [0.0, 0.2], f: [0.75, 1.25] },
  'demo-bot-steady': { logic: 'fair', p: 0.85, t: [0.4, 0.8], f: [0.75, 1.25], streak: 2, close: 0.6 },
  'demo-bot-late': { logic: 'snipe', p: 0.9, t: [0.9, 0.99], f: [1.0, 1.0], close: 0.8 },
  'demo-bot-idle': { logic: 'none', p: 0 },
}

/** How each bot collects what a settled night owes it, so every path gets exercised. */
const COLLECT_BY = {
  'demo-bot-early-a': 'throw', // the next throw collects first (an explicit act collect if it does not throw)
  'demo-bot-early-b': 'collect', // collect(account_id), relayed, unsigned
  'demo-bot-steady': 'act', // a signed {"collect":{...}} action
  'demo-bot-late': 'collect',
  'demo-bot-idle': 'act',
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const uniform = (rng, [a, b]) => a + (b - a) * rng()

/** Tonight's intention, drawn from the bot's own stream: [time as a fraction of the night, size in bp] or null. */
export function planNight(b, rng, always) {
  if (b.logic === 'none') return null
  const playing = rng() < b.p
  const t = uniform(rng, b.t)
  const f = Math.floor(uniform(rng, b.f) * 10_000)
  return playing || always ? { t, fBp: BigInt(f) } : null
}

/** What the bot throws now, given the live state (sim/bonfire_sim.py, `act`). 0n: it holds back. */
export function decide(b, size, fBp, st, balance, cfg) {
  const pile = BigInt(st.pile)
  const target = BigInt(st.target)
  if (b.logic === 'fair') {
    const close = pile * BP >= BigInt(Math.round(b.close * 10_000)) * target
    if (!(st.streak >= b.streak || close)) return 0n
  }
  let amount = (size * fBp) / BP
  if (amount > balance) amount = balance
  if (amount <= 0n) return 0n
  if (b.logic === 'snipe') {
    if (pile >= target) {
      if (BigInt(cfg.late_lit_bp) === 0n) return 0n
    } else {
      const near = pile * BP >= BigInt(Math.round(b.close * 10_000)) * target
      const gap = target - pile
      if (!near || amount < gap) return 0n
      if (BigInt(cfg.late_lit_bp) === 0n) amount = gap
    }
  }
  if (amount < BigInt(cfg.min_throw)) return 0n
  return amount
}

const kset = (s) => new Set(String(s ?? '').split(',').filter(Boolean).map(Number))

export class Runner {
  /**
   * relay: Relay; bots: Player[] in params.json order; cfg: config().config; genesisMs: config().genesis_ms.
   * hooks.step(step) runs after every transaction; hooks.extra(i, n, runner) adds events to a night.
   */
  constructor({ relay, bots, cfg, genesisMs, sizes, seed = 1, always = false, smoke, cold, quiet, hooks = {}, log = console.log }) {
    this.relay = relay
    this.bots = bots
    this.cfg = cfg
    this.genesisMs = genesisMs
    this.nightMs = Number(cfg.night_ms)
    this.sizes = sizes
    this.always = always
    this.smoke = smoke ?? new Set()
    this.cold = cold ?? new Set()
    this.quiet = quiet ?? new Set()
    this.hooks = hooks
    this.log = log
    this.offset = 0
    this.synced = false
    this.rngs = bots.map((_, i) => mulberry32(seed * 7919 + i * 104729 + 1))
    this.steps = []
    this.slot = Object.fromEntries(bots.map((b, i) => [b.account, i]))
  }

  nightStart(n) {
    return this.genesisMs + (n - 1) * this.nightMs
  }

  now() {
    return Date.now() + this.offset
  }

  async state() {
    const st = await view(this.relay.contract, 'state')
    // The chain clock: the optimistic block's time. A node that lags shows an older block, so the
    // clock only ever moves forward (the largest offset seen).
    const off = st.now_ms - Date.now()
    this.offset = this.synced ? Math.max(this.offset, off) : off
    this.synced = true
    return st
  }

  async waitUntil(ms) {
    for (;;) {
      const left = ms - this.now()
      if (left <= 0) return
      if (left > 15_000) {
        await sleep(left - 10_000)
        await this.state()
      } else {
        await sleep(left)
      }
    }
  }

  /** Records a transaction and runs the hook. */
  async step(kind, label, actor, r, extra = {}) {
    const s = { kind, label, actor, ...extra, ...r }
    this.steps.push(s)
    const v = r.value
    const note = r.failure ? `FAILED ${r.failure.slice(0, 160)}` : v && v.ok === false ? `refused: ${v.error}` : ''
    this.log(`${new Date().toISOString().slice(11, 19)} ${label.padEnd(52)} ${tgas(r.gas).padStart(6)} Tgas  ${r.hash}  ${note}`)
    if (this.hooks.step) await this.hooks.step(s)
    return s
  }

  /** Settles every ended night. With `expectDue`, first waits (up to 30 s) for the chain clock to pass the night's end. */
  async settleDue(label = 'settle', expectDue = false) {
    for (let w = 0; expectDue && w < 20; w++) {
      const st = await this.state()
      if (st.nights_due > 0) break
      await sleep(1500)
    }
    for (let tries = 0; tries < 8; tries++) {
      const st = await this.state()
      if (st.nights_due === 0) return
      const r = await this.relay.call('settle', {}, { slot: 6 })
      const v = r.value ?? {}
      await this.step('settle', `${label}: settled ${v.settled ?? '?'} (night ${st.night}${v.settled > 1 ? '-' + (st.night + v.settled - 1) : ''})`, 'relay', r, { settled: v.settled, nights: [st.night, st.night + (v.settled ?? 1) - 1] })
      if (!r.failure && v.nights_due === 0) return
      await sleep(2000)
    }
    throw new Error('settle: nights still due after 8 calls')
  }

  async collectFor(player, how, label) {
    if (how === 'collect') {
      const r = await this.relay.call('collect', { account_id: player.account }, { slot: 7 })
      return this.step('collect', `${label}: collect(${player.label})`, player.account, r, { how })
    }
    const st = await this.state()
    const r = await this.relay.act(player, { collect: { night: st.clock_night } }, { slot: this.slot[player.account] ?? 5 })
    return this.step('act-collect', `${label}: act collect (${player.label})`, player.account, r, { how: 'act' })
  }

  /** Collects for every bot that is owed something, each by its own path. */
  async collectBots(label, throwingTonight = new Set()) {
    for (const b of this.bots) {
      const h = await view(this.relay.contract, 'holder', { account_id: b.account })
      if (h.wood_night === null || BigInt(h.pending) === 0n) continue
      const st = await this.state()
      if (h.wood_night >= st.night) continue
      let how = COLLECT_BY[b.label] ?? 'act'
      if (how === 'throw') {
        if (throwingTonight.has(b.account)) continue // its throw tonight collects first
        how = 'act'
      }
      await this.collectFor(b, how, label)
    }
  }

  /** A bot's throw event for night n of the run's i-th night, or null. */
  botEvent(i, n, b, idx) {
    const beh = BEHAVIOURS[b.label]
    if (!beh) return null
    const plan = planNight(beh, this.rngs[idx], this.always)
    if (!plan) return null
    const smoke = this.smoke.has(i)
    if (this.cold.has(i)) return null
    if (smoke && beh.logic !== 'plain') return { at: 0, skip: true, b, why: 'holds back (smoke night)' }
    let at = this.nightStart(n) + Math.floor(plan.t * this.nightMs)
    at = Math.min(at, this.nightStart(n + 1) - 12_000)
    const fBp = smoke ? plan.fBp / 4n : plan.fBp
    return {
      at,
      b,
      label: `night ${n}: ${b.label} throws`,
      run: async () => {
        const [st, h] = await Promise.all([this.state(), view(this.relay.contract, 'holder', { account_id: b.account })])
        if (st.clock_night !== n) return this.log(`${b.label}: missed night ${n}`)
        const amount = decide(beh, this.sizes[b.label], fBp, st, BigInt(h.balance), this.cfg)
        if (amount === 0n) return this.log(`night ${n}: ${b.label} holds back (pile ${ember(st.pile)} of ${ember(st.target)}, streak ${st.streak})`)
        const r = await this.relay.act(b, { throw: { amount: String(amount), night: n } }, { slot: idx })
        const ev = throwEvent(r)
        return this.step('act-throw', `night ${n} w${ev?.window ?? '-'}: ${b.label} throws ${ember(amount)}`, b.account, r, { amount, night: n, throwEvent: ev })
      },
    }
  }

  async run(nights) {
    const st = await this.state()
    let n = st.clock_night
    if (this.now() - this.nightStart(n) > 0.15 * this.nightMs) n += 1
    this.firstNight = n
    this.log(`bots: ${nights} nights from night ${n} (${new Date(this.nightStart(n)).toISOString()})`)
    for (let i = 1; i <= nights; i++, n++) {
      await this.waitUntil(this.nightStart(n) + 2_500)
      await this.state()
      const late = this.now() - this.nightStart(n)
      if (late > this.nightMs / 2) {
        // The plan is for night n; acting on a later night would only produce refusals. This
        // happens when the machine sleeps: keep it awake (caffeinate -is) for a run.
        throw new Error(`fell ${Math.round(late / 1000)} s behind night ${n}: did the machine sleep?`)
      }
      const quiet = this.quiet.has(i)
      const events = []
      if (!quiet) {
        this.bots.forEach((b, idx) => {
          const e = this.botEvent(i, n, b, idx)
          if (e) events.push(e)
        })
      } else {
        this.bots.forEach((b, idx) => planNight(BEHAVIOURS[b.label], this.rngs[idx], this.always)) // keep the streams aligned
        this.log(`night ${n}: quiet, nobody calls anything`)
      }
      for (const e of events.filter((x) => x.skip)) this.log(`night ${n}: ${e.b.label} ${e.why}`)
      const throws = events.filter((x) => !x.skip)
      if (this.hooks.night) await this.hooks.night(i, n, { quiet, smoke: this.smoke.has(i), cold: this.cold.has(i) })
      if (!quiet) {
        await this.settleDue(`night ${n} opens`, i > 1 || n > this.firstNight)
        await this.collectBots(`night ${n} opens`, new Set(throws.map((e) => e.b.account)))
      }
      if (this.hooks.extra) for (const e of (await this.hooks.extra(i, n, this)) ?? []) throws.push(e)
      throws.sort((a, b) => a.at - b.at)
      for (const e of throws) {
        await this.waitUntil(e.at)
        await e.run()
      }
    }
    await this.waitUntil(this.nightStart(n) + 2_500)
    await this.settleDue(`after night ${n - 1}`, true)
    await this.collectBots(`after night ${n - 1}`)
    if (this.hooks.extra) for (const e of (await this.hooks.extra(nights + 1, n, this)) ?? []) await e.run()
    return this.steps
  }
}

// ---- command line ---------------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2)
  const opt = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const contract = argv[0]
  const nights = Number(opt('--nights'))
  if (!contract || contract.startsWith('--') || !(nights >= 1 && nights <= 2_000)) {
    console.error('usage: bots.mjs <contract> --nights <N> [--seed <s>] [--always] [--smoke <k>] [--cold <k>] [--quiet <k>]')
    process.exit(64)
  }
  const relay = new Relay(contract)
  const bots = loadBots(contract)
  const { config: cfg, genesis_ms: genesisMs } = await view(contract, 'config')
  const params = readJson(join(ROOT, 'sim', 'params.json')).testnet
  const sizes = Object.fromEntries(params.demo_bots.map((d) => [d.label, BigInt(d.throw)]))
  const runner = new Runner({
    relay, bots, cfg, genesisMs, sizes,
    seed: Number(opt('--seed') ?? 1),
    always: argv.includes('--always'),
    smoke: kset(opt('--smoke')),
    cold: kset(opt('--cold')),
    quiet: kset(opt('--quiet')),
  })
  const steps = await runner.run(nights)
  const audit = await view(contract, 'audit')
  console.log(`audit: balanced ${audit.balanced}, ledger ${audit.ledger}, supply ${ember(audit.supply)}, hearth ${ember(audit.hearth)}, owed ${ember(audit.owed)}`)
  const failed = steps.filter((s) => s.failure)
  console.log(`${steps.length} transactions, ${failed.length} failed`)
  process.exit(failed.length || !audit.balanced || !audit.ledger ? 1 : 0)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main()
