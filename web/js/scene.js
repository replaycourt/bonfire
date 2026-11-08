// The night scene, drawn in Canvas 2D: sky, moon, hills, the fire pit, the pile of wood with its target
// line, flames, sparks, smoke and the silhouettes of tonight's throwers. Original art made of paths
// and gradients. The scene knows nothing about the chain; main.js feeds it numbers.
import { hashSeed } from './logic.js'

export const FONT = '"Bonfire Display", ui-rounded, "SF Pro Rounded", "Nunito", "Avenir Next", "Segoe UI", system-ui, sans-serif'
const TAU = Math.PI * 2
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const lerp = (a, b, t) => a + (b - a) * t
const easeOut = (t) => 1 - Math.pow(1 - t, 3)
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

function rng(seed) {
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

const mix = (c1, c2, t) => c1.map((v, i) => Math.round(lerp(v, c2[i], t)))
const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`

// Rows of the pile: the target fills TARGET_ROWS rows; the pile can grow to MAX_ROWS (150 %).
const TARGET_ROWS = 6
const MAX_ROWS = 9
const ROW_H = 17
// Dawn on stage: the sky stays warm (lit) or pale (smoke) this long, then turns back to night in 2 s.
const STAGE_HOLD = 7
// The flame on a cold pile is about 30 % of a lit night's roar, and grows with the pile.
const HEAT_MIN = 0.4
const HEAT_ROAR = 1.65

export class Scene {
  constructor(canvas, { reducedMotion = false, size = null } = {}) {
    this.canvas = canvas
    this.size = size // a fixed { width, height, dpr } for pictures drawn off screen (renderStill)
    this.ctx = canvas.getContext('2d')
    this.reduced = reducedMotion
    this.W = 0
    this.H = 0
    this.dpr = 1
    this.t = 0
    this.last = 0
    this.running = false
    // what the night looks like
    this.progress = 0.3
    this.pct = 0 // pile / target (eased for display)
    this.pctTarget = 0
    this.reached = false
    this.cold = false // no contract yet: an unlit pit
    this.pileText = ''
    this.targetText = ''
    this.heat = 0.25 // flame intensity, eased toward heatGoal
    this.heatGoal = 0.25
    this.roar = 0 // time left of a lit night's roar (s)
    this.smokeOut = 0 // time left of a smoky night's smoke (s)
    this.veil = 0 // grey veil after smoke
    this.stage = null // dawn on stage: { kind, t0, dawn0 } while the sky is warm or pale
    this.markFade = 1 // the target line and its label step aside while a night burns or smokes
    this.skyOpen = false // the page has taken the clock and the rules off the sky (dawn, the film)
    this.topNow = null // how high a flame may reach now, eased between layout.flameTop and flameTopOpen
    this.rainT = 0
    this.seats = []
    this.more = 0
    this.sparks = []
    this.smoke = []
    this.flying = []
    this.floats = []
    this.logState = new Map() // log index -> shownAt
    this.stars = []
    this.hills = null
    // cx, by: the fire's spot (shares of the stage); scale; moon: { x0, x1, y, lift } in px; free:
    // { l, r }, the stretch of the stage not under a card; flameTop: how high a roar may reach (px)
    this.layout = { cx: 0.5, by: 0.76, scale: 1, moon: null, free: null, flameTop: null }
    this.onFrame = null
    this.buildPile()
  }

  // ---- setup ------------------------------------------------------------------------------------

  setLayout(l) {
    this.layout = { ...this.layout, ...l }
    this.resize()
  }

  resize() {
    const r = this.size ? { width: this.size.width, height: this.size.height } : this.canvas.getBoundingClientRect()
    const dpr = this.size?.dpr ?? Math.min(2, globalThis.devicePixelRatio || 1)
    const W = Math.max(1, Math.round(r.width))
    const H = Math.max(1, Math.round(r.height))
    const L = this.layout
    // the fire grows with the stage's height, up to 1.7 times its designed size
    const u = clamp(Math.min(W / 700, H / 620), 0.5, 1.7) * (L.scale ?? 1)
    this.W = W
    this.H = H
    this.dpr = dpr
    this.u = u
    this.cx = W * L.cx
    this.by = H * L.by
    this.horizon = Math.min(H * 0.6, this.by - 70 * u)
    const key = [W, H, dpr, u, L.cx, L.by].join()
    if (key === this.geoKey && this.hills) return
    this.geoKey = key
    this.canvas.width = Math.round(W * dpr)
    this.canvas.height = Math.round(H * dpr)
    this.makeStars()
    this.makeHills()
  }

  makeStars() {
    const r = rng(1234)
    const n = Math.round(clamp((this.W * this.H) / 6500, 60, 260))
    this.stars = Array.from({ length: n }, () => {
      const y = Math.pow(r(), 1.6) * this.horizon * 0.95
      return { x: r() * this.W, y, s: 0.5 + r() * (r() < 0.08 ? 1.6 : 0.9), p: r() * TAU, v: 0.6 + r() * 1.8, a: 0.35 + r() * 0.6 }
    })
  }

  makeHills() {
    const { W, H, horizon, u } = this
    const c = document.createElement('canvas')
    c.width = Math.round(W * this.dpr)
    c.height = Math.round(H * this.dpr)
    const g = c.getContext('2d')
    g.scale(this.dpr, this.dpr)
    const r = rng(77)
    const ridge = (base, amp, color, seed, pines) => {
      const rr = rng(seed)
      const f = [0.004 + rr() * 0.003, 0.009 + rr() * 0.004, 0.021 + rr() * 0.01]
      const ph = [rr() * 9, rr() * 9, rr() * 9]
      const yAt = (x) => base - amp * (0.55 * Math.sin(x * f[0] + ph[0]) + 0.3 * Math.sin(x * f[1] + ph[1]) + 0.15 * Math.sin(x * f[2] + ph[2]))
      g.beginPath()
      g.moveTo(0, H)
      for (let x = 0; x <= W + 8; x += 8) g.lineTo(x, yAt(x))
      g.lineTo(W, H)
      g.closePath()
      g.fillStyle = color
      g.fill()
      if (pines) {
        g.fillStyle = color
        const count = Math.round(W / (26 * u))
        for (let i = 0; i < count; i++) {
          const x = rr() * W
          // leave the sky above the fire open
          if (Math.abs(x - this.cx) < 210 * u && rr() < 0.85) continue
          const h = (26 + rr() * 52) * u * pines
          const y = yAt(x) + 4
          const w = h * 0.36
          g.beginPath()
          for (let k = 0; k < 3; k++) {
            const top = y - h + k * h * 0.22
            const bw = w * (0.55 + k * 0.28)
            g.moveTo(x, top)
            g.lineTo(x + bw, top + h * 0.42)
            g.lineTo(x - bw, top + h * 0.42)
          }
          g.closePath()
          g.fill()
          g.fillRect(x - 1.5 * u, y - h * 0.15, 3 * u, h * 0.2)
        }
      }
    }
    ridge(horizon - 30 * u, 34 * u, '#15132f', 11, 0)
    ridge(horizon - 6 * u, 22 * u, '#0f0d24', 12, 0.8)
    ridge(horizon + 10 * u, 12 * u, '#0a0918', 13, 1.15)
    // the ground
    const gr = g.createLinearGradient(0, horizon, 0, H)
    gr.addColorStop(0, '#0b0915')
    gr.addColorStop(1, '#050409')
    g.fillStyle = gr
    g.fillRect(0, horizon + 18 * u, W, H)
    // a few grass tufts and pebbles on the ground
    g.strokeStyle = 'rgba(30,26,46,0.9)'
    g.lineWidth = 1.2
    for (let i = 0; i < W / 9; i++) {
      const x = r() * W
      const y = horizon + 24 * u + Math.pow(r(), 0.7) * (H - horizon)
      if (Math.abs(x - this.cx) < 150 * u && Math.abs(y - this.by) < 40 * u) continue
      const h = (3 + r() * 7) * u
      g.beginPath()
      g.moveTo(x, y)
      g.lineTo(x - 2, y - h)
      g.moveTo(x, y)
      g.lineTo(x + 2.5, y - h * 0.8)
      g.stroke()
    }
    this.hills = c
  }

  /** A deterministic pile: rows of logs, wide at the bottom, criss-crossed like a real bonfire. */
  buildPile() {
    const r = rng(4242)
    const logs = []
    for (let row = 0; row < MAX_ROWS; row++) {
      const count = Math.max(1, Math.round(6 - row * 0.62))
      const half = 104 * (1 - row / (MAX_ROWS + 1.2))
      for (let k = 0; k < count; k++) {
        const slot = count === 1 ? 0 : (k / (count - 1)) * 2 - 1
        const lean = r() < 0.22 + row * 0.07 ? (slot < 0 ? -1 : 1) * (0.45 + r() * 0.45) : (r() - 0.5) * 0.45
        logs.push({
          row,
          x: slot * half * 0.64 + (r() - 0.5) * 12,
          y: row * ROW_H + 8 + r() * 4,
          len: 50 + r() * 26 - row * 2.2,
          th: 11 + r() * 4,
          a: lean,
          tone: r(),
          flip: r() < 0.5,
          order: r(),
        })
      }
    }
    // within a row, the logs that reach highest come last; rows bottom first
    for (const l of logs) l.top = l.y + Math.abs(Math.sin(l.a)) * l.len * 0.5 + l.th * 0.5
    logs.sort((a, b) => a.row - b.row || a.top - b.top)
    this.fullTop = Math.max(...logs.filter((l) => l.row < TARGET_ROWS).map((l) => l.top))
    this.pileLogs = logs
    this.rowCounts = Array.from({ length: MAX_ROWS }, (_, row) => logs.filter((l) => l.row === row).length)
  }

  // ---- inputs -----------------------------------------------------------------------------------

  /** Night progress 0..1, pile/target, reached, labels. */
  setNight({ progress, pct, reached, pileText, pileShort = pileText, targetText, cold = false }) {
    this.pileShort = pileShort
    this.progress = progress
    this.pctTarget = clamp(pct, 0, 1.5)
    this.reached = reached
    this.pileText = pileText
    this.targetText = targetText
    this.cold = cold
    if (this.reduced || this.pct === 0) this.pct = this.pctTarget
    if (!this.roar && !this.smokeOut) this.heatGoal = this.baseHeat()
    if (cold) this.heat = 0
  }

  baseHeat() {
    if (this.cold) return 0
    return HEAT_MIN + 0.3 * Math.min(this.pctTarget, 1) + (this.reached ? 0.08 : 0)
  }

  /** How warm (lit) or pale (smoke) the sky is now, 0..1, and how far dawn has come. */
  skyStage() {
    const st = this.stage
    if (!st) return { warm: 0, pale: 0, hold: 0 }
    const age = this.t - st.t0
    const out = 1 - smooth(STAGE_HOLD, STAGE_HOLD + 2, age)
    const inn = this.reduced ? 1 : smooth(0, 0.9, age)
    return { warm: st.kind === 'lit' ? inn * out : 0, pale: st.kind !== 'lit' ? inn * out * (st.kind === 'cold' ? 0.5 : 1) : 0, hold: Math.max(st.dawn0 ?? 0, inn) * out }
  }

  /** Figures raise their arms while a lit night roars, 0..1. */
  cheering() {
    const st = this.stage
    if (!st || st.kind !== 'lit') return 0
    const age = this.t - st.t0
    return this.reduced ? (age < STAGE_HOLD - 1 ? 1 : 0) : smooth(0.1, 0.5, age) * (1 - smooth(STAGE_HOLD - 1.5, STAGE_HOLD - 0.5, age))
  }

  /** Seats around the fire: [{account, seed, me}], and how many more are not shown. */
  setSeats(shown, more) {
    const keep = new Map(this.seats.map((s) => [s.account, s]))
    const slots = this.seatSlots(shown.length)
    this.seats = shown.map((s, i) => {
      const old = keep.get(s.account)
      return { ...s, slot: slots[i], born: old ? old.born : this.t, look: old?.look ?? lookFor(s.seed) }
    })
    this.more = more
  }

  seatSlots(n) {
    // right and left alternately: front sides, back sides, then closer to the middle
    const right = [0.32, -0.6, -1.0, 0.85, -1.3]
    const slots = []
    for (const r of right) slots.push(r, Math.PI - r)
    return slots.slice(0, n)
  }

  /** A log flies from a seat (or from below for the player without a seat yet) onto the pile. */
  throwFrom(account, text) {
    if (this.reduced) {
      if (text) this.floats.push({ text, x: this.cx, y: this.pileTop() - 30 * this.u, t0: this.t, life: 1.6 })
      return
    }
    const seat = this.seats.find((s) => s.account === account)
    let from
    if (seat) {
      const p = this.seatPos(seat.slot)
      from = { x: p.x, y: p.y - 40 * this.u * p.s }
    } else {
      from = { x: this.cx + (Math.random() - 0.5) * 160 * this.u, y: this.H + 20 }
    }
    this.flying.push({ from, to: { x: this.cx + (Math.random() - 0.5) * 50 * this.u, y: this.pileTop() + 6 * this.u }, t0: this.t, dur: 0.75, spin: (Math.random() - 0.5) * 9, text })
  }

  /** A short line over the fire, for a firestarter or a last log, with a puff of sparks. */
  cheer(text, big = false) {
    const y = this.pileTop() - 46 * this.u
    this.floats.push({ text, x: this.cx, y, t0: this.t, life: 2.6 })
    if (!this.reduced) for (let i = 0; i < (big ? 46 : 18); i++) this.spark(this.cx + (Math.random() - 0.5) * 40 * this.u, this.pileTop(), big ? 2.2 : 1.5)
  }

  /** The night has been settled: 'LIT' roars, 'SMOKED' and 'COLD' sink into grey. */
  outcome(kind) {
    kind = String(kind).toLowerCase()
    // the night's pile stays on screen while it burns (lit) or smoulders (smoke)
    this.ash = { pct: Math.max(this.pct, this.pctTarget), t0: this.t, kind }
    // the sky turns warm (or pale) and stays so for a while, from wherever the night's dawn had it
    this.stage = { kind, t0: this.t, dawn0: this.dawn ?? 0 }
    this.rainT = 0.7
    if (kind === 'lit') {
      this.roar = 10
      this.smokeOut = 0
      this.coldNight = false
      this.heatGoal = HEAT_ROAR
      if (!this.reduced) this.burst(140)
    } else {
      // a cold night had no wood: no plume, just a dark, quiet pit for a while
      this.smokeOut = kind === 'cold' ? 7 : 10
      this.coldNight = kind === 'cold'
      this.roar = 0
      this.heatGoal = 0.03
      this.veilGoal = kind === 'cold' ? 0.7 : 1
    }
  }

  // ---- geometry ---------------------------------------------------------------------------------

  seatPos(theta) {
    // the circle stays between the cards, its figures clear of them
    const free = this.layout.free
    const room = free ? (Math.min(this.cx - free.l, free.r - this.cx) - 34 * this.u) / 0.97 : Infinity
    const rx = Math.max(150 * this.u, Math.min(265 * this.u, this.W * 0.43, room))
    const ry = 66 * this.u
    const x = this.cx + rx * Math.cos(theta)
    const y = this.by + 4 * this.u + ry * Math.sin(theta)
    const depth = (Math.sin(theta) + 1) / 2 // 0 back, 1 front
    return { x, y, s: lerp(0.78, 1.08, depth) * this.u, front: Math.sin(theta) > 0 }
  }

  rowsShown() {
    return this.pct * TARGET_ROWS
  }

  pileTop() {
    const rows = this.rowsShown()
    let top = 0
    this.forLogs(rows, (l) => (top = Math.max(top, l.top)))
    return this.by - Math.max(10, top) * this.u
  }

  targetY() {
    return this.by - (this.fullTop + 3) * this.u
  }

  // ---- loop -------------------------------------------------------------------------------------

  start() {
    if (this.running) return
    this.running = true
    const tick = (ms) => {
      if (!this.running) return
      const now = ms / 1000
      const dt = this.last ? clamp(now - this.last, 0, 0.1) : 0.016
      this.last = now
      requestAnimationFrame(tick) // first: one bad frame must not stop the fire for good
      if (!document.hidden) this.frame(dt)
    }
    requestAnimationFrame(tick)
  }

  /** Draws one frame now (for tests and the first paint). */
  frame(dt) {
    this.step(dt)
    this.draw()
    this.onFrame?.()
  }

  step(dt) {
    const motion = this.reduced ? 0 : 1
    this.t += dt
    // pile height eases toward the real pile
    this.pct = this.reduced ? this.pctTarget : lerp(this.pct, this.pctTarget, 1 - Math.exp(-dt * 3))
    if (Math.abs(this.pct - this.pctTarget) < 0.002) this.pct = this.pctTarget
    if (this.roar > 0) {
      this.roar -= dt
      if (this.roar <= 3.5) this.heatGoal = this.baseHeat()
      if (this.roar <= 0) this.roar = 0
      // a rain of sparks for the first seconds of a lit night
      if (!this.reduced && this.roar > 6) {
        this.rainT -= dt
        if (this.rainT <= 0) {
          this.burst(50)
          this.rainT = 0.75
        }
      }
    }
    if (this.stage && this.t - this.stage.t0 > STAGE_HOLD + 2) this.stage = null
    const topGoal = this.skyOpen && this.layout.flameTopOpen != null ? this.layout.flameTopOpen : this.layout.flameTop
    this.topNow = topGoal == null ? null : this.topNow == null || this.reduced ? topGoal : lerp(this.topNow, topGoal, 1 - Math.exp(-dt * 2.5))
    const markGoal = this.roar > 0 || this.smokeOut > 0 || this.stage ? 0 : 1
    this.markFade = this.reduced ? markGoal : lerp(this.markFade, markGoal, 1 - Math.exp(-dt * 5))
    if (this.smokeOut > 0) {
      this.smokeOut -= dt
      if (this.smokeOut <= 3) {
        this.heatGoal = this.baseHeat()
        this.veilGoal = 0
      }
      if (this.smokeOut <= 0) this.smokeOut = 0
    }
    const k = this.reduced ? 1 : 1 - Math.exp(-dt * (this.heatGoal > this.heat ? 2.2 : 0.9))
    this.heat = lerp(this.heat, this.heatGoal, k)
    this.veil = this.reduced ? (this.veilGoal ?? 0) : lerp(this.veil, this.veilGoal ?? 0, 1 - Math.exp(-dt * 1.2))

    if (motion) {
      // sparks
      const rate = (this.cold ? 0 : 3 + 40 * Math.pow(this.heat, 2.2)) * dt
      for (let i = 0; i < rate || (i === 0 && Math.random() < rate); i++) this.spark()
      // smoke: a thin wisp always, a column after a smoky night
      const smokeRate = (this.smokeOut > 0 ? (this.coldNight ? 2.5 : this.smokeOut > 4 ? 26 : 10) : this.cold ? 1.6 : this.pct < 0.05 ? 0.45 : 0.9) * dt
      if (Math.random() < smokeRate - Math.floor(smokeRate) || smokeRate >= 1) for (let i = 0; i < Math.max(1, Math.floor(smokeRate)); i++) this.puff()
    }
    for (const p of this.sparks) {
      p.life -= dt
      p.vy -= 18 * this.u * dt
      p.x += (p.vx + Math.sin(this.t * p.w + p.p) * 22 * this.u) * dt
      p.y += p.vy * dt
    }
    this.sparks = this.sparks.filter((p) => p.life > 0 && p.y > -10)
    for (const p of this.smoke) {
      p.life -= dt
      p.x += (p.vx + Math.sin(this.t * 0.6 + p.p) * 6 * this.u) * dt
      p.y += p.vy * dt
      p.r += p.grow * dt
    }
    this.smoke = this.smoke.filter((p) => p.life > 0)
    for (const f of this.flying) {
      if (!f.landed && this.t - f.t0 >= f.dur) {
        f.landed = true
        for (let i = 0; i < 18; i++) this.spark(f.to.x, f.to.y, 1.6)
        if (f.text) this.floats.push({ text: f.text, x: f.to.x, y: f.to.y - 26 * this.u, t0: this.t, life: 1.8 })
      }
    }
    this.flying = this.flying.filter((f) => !f.landed)
    this.floats = this.floats.filter((f) => this.t - f.t0 < f.life)
  }

  spark(x, y, boost = 1) {
    const u = this.u
    const h = this.flameH()
    this.sparks.push({
      x: x ?? this.cx + (Math.random() - 0.5) * this.flameW() * 0.8,
      y: y ?? this.flameBase() - Math.random() * h * 0.5,
      vx: (Math.random() - 0.5) * 40 * u * boost,
      vy: -(50 + Math.random() * 140 * (0.5 + this.heat)) * u * boost,
      life: 0.8 + Math.random() * 2.2,
      max: 3,
      r: (0.6 + Math.random() * 1.1) * Math.max(0.8, u),
      w: 2 + Math.random() * 4,
      p: Math.random() * TAU,
      hot: Math.random(),
    })
  }

  burst(n) {
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6
      const v = (160 + Math.random() * 380) * this.u
      this.sparks.push({
        x: this.cx + (Math.random() - 0.5) * 60 * this.u,
        y: this.flameBase() - 30 * this.u,
        vx: Math.cos(a) * v * 0.6,
        vy: Math.sin(a) * v,
        life: 1.2 + Math.random() * 2.6,
        max: 3.8,
        r: (0.6 + Math.random() * 1.3) * Math.max(0.8, this.u),
        w: 2 + Math.random() * 4,
        p: Math.random() * TAU,
        hot: Math.random(),
      })
    }
  }

  puff() {
    const u = this.u
    const heavy = this.smokeOut > 0 && !this.coldNight
    this.smoke.push({
      x: this.cx + (Math.random() - 0.5) * (heavy ? 110 : 50) * u,
      y: this.flameBase() - (heavy ? 10 : this.flameH() * 0.8) * u,
      vx: (6 + Math.random() * 14) * u,
      vy: -(heavy ? 38 + Math.random() * 40 : 16 + Math.random() * 12) * u,
      r: (heavy ? 16 : 8) * u,
      grow: (heavy ? 15 : 9) * u,
      life: heavy ? 6 + Math.random() * 3 : 4 + Math.random() * 2,
      max: 9,
      p: Math.random() * TAU,
      a: heavy ? 0.42 : 0.12,
      tone: Math.random(),
    })
    const last = this.smoke[this.smoke.length - 1]
    last.max = last.life
  }

  flameBase() {
    return this.by - (this.roar > 0 ? 8 : 7 + Math.min(this.rowsShown(), TARGET_ROWS) * 1.6) * this.u
  }
  flameH() {
    const raw = (26 + 230 * this.heat) * this.u
    const top = this.topNow ?? this.layout.flameTop
    if (top == null) return raw
    // a roar may reach up to the clock, never out of the sky: soft above 60 % of the room
    const room = Math.max(40, this.flameBase() - top)
    const knee = room * 0.6
    return raw <= knee ? raw : knee + (room - knee) * Math.tanh((raw - knee) / (room - knee))
  }
  flameW() {
    return (30 + 78 * Math.min(this.heat, 1.4)) * this.u
  }

  // ---- drawing ----------------------------------------------------------------------------------

  draw() {
    const { ctx, W, H, dpr } = this
    if (!W || !this.hills) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.drawSky()
    this.drawStars()
    this.drawMoon()
    ctx.drawImage(this.hills, 0, 0, W, H)
    this.drawGlow()
    const back = this.seats.filter((s) => !this.seatPos(s.slot).front)
    const front = this.seats.filter((s) => this.seatPos(s.slot).front)
    back.sort((a, b) => this.seatPos(a.slot).y - this.seatPos(b.slot).y).forEach((s) => this.drawPerson(s))
    if (!this.seats.length && !this.cold) this.drawEmptySeats()
    this.drawStones(false)
    this.drawGhost()
    this.drawTargetLine()
    this.drawEmbers()
    this.drawPile('upper')
    this.drawFlames()
    this.drawPile('lower')
    this.drawStones(true)
    this.drawMore()
    front.forEach((s) => this.drawPerson(s))
    this.drawSmoke()
    this.drawSparks()
    this.drawFlying()
    this.drawTargetLabel()
    this.drawFloats()
    this.drawVeil()
  }

  drawSky() {
    const { ctx, W, horizon } = this
    const sky = this.skyStage()
    const dawn = Math.max(smooth(0.78, 1, this.progress), sky.hold) * (this.cold ? 0 : 1)
    let top = mix([5, 6, 18], [14, 16, 42], dawn * 0.6)
    let mid = mix([13, 14, 42], [34, 30, 78], dawn)
    let low = mix([40, 24, 58], [122, 64, 82], dawn)
    // a lit night's dawn: a warm horizon, rose to orange; a smoky one: a pale, washed-out sky
    if (sky.warm > 0) {
      top = mix(top, [30, 20, 54], sky.warm)
      mid = mix(mid, [104, 56, 98], sky.warm)
      low = mix(low, [236, 136, 92], sky.warm)
    }
    if (sky.pale > 0) {
      top = mix(top, [36, 36, 48], sky.pale)
      mid = mix(mid, [74, 72, 88], sky.pale)
      low = mix(low, [126, 122, 134], sky.pale)
    }
    const g = ctx.createLinearGradient(0, 0, 0, horizon + 30 * this.u)
    g.addColorStop(0, rgb(top))
    g.addColorStop(0.55, rgb(mid))
    g.addColorStop(1, rgb(low))
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, this.H)
    if (sky.warm > 0.01) {
      // the sun's glow just under the ridge
      const sun = ctx.createRadialGradient(this.cx, horizon + 20 * this.u, 10, this.cx, horizon + 20 * this.u, W * 0.6)
      sun.addColorStop(0, `rgba(255,190,120,${0.42 * sky.warm})`)
      sun.addColorStop(0.5, `rgba(255,130,90,${0.14 * sky.warm})`)
      sun.addColorStop(1, 'rgba(255,120,90,0)')
      ctx.fillStyle = sun
      ctx.fillRect(0, 0, W, horizon + 40 * this.u)
    }
    this.dawn = dawn
    this.skyNow = sky
  }

  drawStars() {
    const { ctx } = this
    const fade = (1 - (this.dawn ?? 0) * 0.7) * (1 - 0.6 * (this.skyNow?.warm ?? 0))
    for (const s of this.stars) {
      const tw = this.reduced ? 0.85 : 0.65 + 0.35 * Math.sin(this.t * s.v + s.p)
      ctx.globalAlpha = s.a * tw * fade
      ctx.fillStyle = '#fff6e0'
      ctx.beginPath()
      ctx.arc(s.x, s.y, s.s, 0, TAU)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }

  /** The moon's radius, for the page's layout of its path. */
  moonRadius() {
    return 17 * Math.max(0.8, Math.min(this.u || 1, 1.4))
  }

  drawMoon() {
    const { ctx, W, u } = this
    const p = clamp(this.progress, 0, 1)
    const m = this.layout.moon && Number.isFinite(this.layout.moon.x0 + this.layout.moon.x1 + this.layout.moon.y + this.layout.moon.lift) ? this.layout.moon : null
    const x = m ? lerp(m.x0, m.x1, p) : lerp(W * 0.06, W * 0.94, p)
    const y = m ? m.y - Math.sin(p * Math.PI) * m.lift : this.H * 0.3 - Math.sin(p * Math.PI) * this.H * 0.045
    const r = this.moonRadius()
    void u
    const glow = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 5)
    glow.addColorStop(0, 'rgba(255,240,205,0.22)')
    glow.addColorStop(1, 'rgba(255,240,205,0)')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(x, y, r * 5, 0, TAU)
    ctx.fill()
    // a crescent: the lit disk minus an offset disk, cut out of an offscreen layer
    if (!this.moonCanvas || this.moonR !== r) {
      const c = document.createElement('canvas')
      const size = Math.ceil(r * 2 + 4)
      c.width = c.height = size * 2
      const g = c.getContext('2d')
      g.scale(2, 2)
      g.fillStyle = '#f6ecd0'
      g.beginPath()
      g.arc(size / 2, size / 2, r, 0, TAU)
      g.fill()
      g.globalCompositeOperation = 'destination-out'
      g.beginPath()
      g.arc(size / 2 + r * 0.55, size / 2 - r * 0.25, r * 0.92, 0, TAU)
      g.fill()
      this.moonCanvas = c
      this.moonR = r
    }
    const size = this.moonCanvas.width / 2
    ctx.drawImage(this.moonCanvas, x - size / 2, y - size / 2, size, size)
  }

  drawGlow() {
    const { ctx, cx, by, u } = this
    const I = clamp(this.heat, 0, 1.8)
    if (I <= 0.01) return
    ctx.save()
    ctx.globalCompositeOperation = 'screen'
    // light in the air
    const r1 = (240 + 420 * I) * u
    const g1 = ctx.createRadialGradient(cx, by - 60 * u, 10, cx, by - 60 * u, r1)
    g1.addColorStop(0, `rgba(255,150,60,${0.32 * Math.min(I, 1.2)})`)
    g1.addColorStop(0.4, `rgba(220,90,40,${0.12 * Math.min(I, 1.2)})`)
    g1.addColorStop(1, 'rgba(120,40,30,0)')
    ctx.fillStyle = g1
    ctx.fillRect(0, 0, this.W, this.H)
    // light on the ground
    ctx.translate(cx, by + 6 * u)
    ctx.scale(1, 0.26)
    const r2 = (220 + 380 * I) * u
    const g2 = ctx.createRadialGradient(0, 0, 0, 0, 0, r2)
    g2.addColorStop(0, `rgba(255,140,60,${0.42 * Math.min(I, 1.2)})`)
    g2.addColorStop(1, 'rgba(255,120,40,0)')
    ctx.fillStyle = g2
    ctx.beginPath()
    ctx.arc(0, 0, r2, 0, TAU)
    ctx.fill()
    ctx.restore()
  }

  drawStones(front) {
    const { ctx, cx, by, u } = this
    const n = 16
    const rx = 128 * u
    const ry = 26 * u
    const I = clamp(this.heat, 0, 1.4)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + 0.1
      const isFront = Math.sin(a) > 0
      if (isFront !== front) continue
      const x = cx + Math.cos(a) * rx
      const y = by + 2 * u + Math.sin(a) * ry
      const r = (11 + ((i * 7) % 5)) * u
      ctx.fillStyle = '#2a2527'
      ctx.beginPath()
      ctx.ellipse(x, y, r * 1.25, r * 0.78, 0, 0, TAU)
      ctx.fill()
      const lit = front ? 0.18 : 0.45
      ctx.fillStyle = `rgba(255,150,80,${lit * I})`
      ctx.beginPath()
      ctx.ellipse(x, y - r * 0.3, r * 0.95, r * 0.36, 0, Math.PI, TAU)
      ctx.fill()
    }
  }

  drawGhost() {
    // the outline of tonight's pile: what the target looks like
    const { ctx, cx, by, u } = this
    if (this.cold) return
    const ty = this.targetY()
    const w0 = 128 * u
    const w1 = 34 * u
    ctx.save()
    ctx.setLineDash([5 * u, 6 * u])
    ctx.lineWidth = 1.5
    ctx.strokeStyle = this.reached ? 'rgba(255,214,120,0.0)' : 'rgba(255,214,150,0.22)'
    ctx.beginPath()
    ctx.moveTo(cx - w0, by)
    ctx.quadraticCurveTo(cx - w0 * 0.75, ty + 20 * u, cx - w1, ty)
    ctx.lineTo(cx + w1, ty)
    ctx.quadraticCurveTo(cx + w0 * 0.75, ty + 20 * u, cx + w0, by)
    ctx.stroke()
    ctx.restore()
  }

  drawPile(pass) {
    const { cx, by, u } = this
    const rowOk = (log) => (pass === 'lower' ? log.row === 0 : log.row > 0)
    const I = clamp(this.heat, 0, 1.6)
    // last night's pile, burning down after the outcome
    const ash = this.ash
    if (ash) {
      const age = this.t - ash.t0
      const lit = ash.kind === 'lit'
      const life = lit ? 11 : 9
      if (age > life) this.ash = null
      else {
        const alpha = 1 - smooth(life - 2, life, age)
        // a lit pile burns down from the top while the roar dies; a smoky one sags and greys
        const char = lit ? 0.75 * smooth(4, 9.5, age) : smooth(0, 3, age)
        const burning = lit && age < 9 ? 1 - smooth(5.5, 9, age) : 0
        const rows = ash.pct * TARGET_ROWS * (1 - (lit ? 0.8 * smooth(3.5, 9.5, age) : 0.4 * smooth(2, 8, age)))
        // drawn over the flames, glowing; as it burns down it shows the flames above it
        this.forLogs(rows, (log) => {
          if (pass !== 'lower') return
          this.ctx.globalAlpha = alpha
          this.drawLog(cx + log.x * u, by - log.y * u, log.len * u, log.th * u, log.a, log.tone, log.flip, I, burning, log.y / (TARGET_ROWS * ROW_H), char)
          this.ctx.globalAlpha = 1
        })
      }
    }
    // tonight's pile; new logs drop in
    this.forLogs(this.rowsShown(), (log, index, fresh) => {
      if (fresh) this.logState.set(index, this.t)
      if (!rowOk(log)) return
      const age = this.t - (this.logState.get(index) ?? -9)
      const drop = this.reduced ? 0 : (1 - easeOut(clamp(age / 0.4, 0, 1))) * 26 * u
      this.drawLog(cx + log.x * u, by - log.y * u - drop, log.len * u, log.th * u, log.a, log.tone, log.flip, I, 0, log.y / (TARGET_ROWS * ROW_H), 0)
    })
  }

  /** Calls fn(log, index, fresh) for every log of a pile `rows` rows high. */
  forLogs(rows, fn) {
    let index = 0
    for (let row = 0; row < MAX_ROWS; row++) {
      const count = this.rowCounts[row]
      const visible = Math.ceil(clamp(rows - row, 0, 1) * count - 1e-6)
      for (let k = 0; k < count; k++, index++) {
        if (k >= visible) {
          if (fn.length > 2) this.logState.delete(index)
          continue
        }
        fn(this.pileLogs[index], index, fn.length > 2 && !this.logState.has(index))
      }
    }
  }

  drawLog(x, y, len, th, a, tone, flip, I, burning, height, char = 0) {
    const { ctx } = this
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(a)
    const bark = mix(mix([86, 54, 32], [58, 36, 22], tone), [34, 30, 34], char)
    const lit = clamp(0.25 + 0.55 * I * (1 - height * 0.5), 0, 1)
    const g = ctx.createLinearGradient(0, -th / 2, 0, th / 2)
    g.addColorStop(0, rgb(mix(bark, [255, 170, 90], lit * 0.55)))
    g.addColorStop(0.6, rgb(bark))
    g.addColorStop(1, rgb(mix(bark, [20, 12, 10], 0.6)))
    ctx.fillStyle = g
    roundRect(ctx, -len / 2, -th / 2, len, th, th / 2)
    ctx.fill()
    // bark lines
    ctx.strokeStyle = 'rgba(30,18,10,0.45)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(-len / 2 + th, -th * 0.1)
    ctx.lineTo(len / 2 - th * 1.4, -th * 0.15)
    ctx.stroke()
    // the cut end, with rings
    const ex = flip ? -len / 2 + th * 0.35 : len / 2 - th * 0.35
    ctx.fillStyle = rgb(mix(mix([214, 160, 98], [255, 196, 120], lit * 0.5), [70, 64, 66], char))
    ctx.beginPath()
    ctx.ellipse(ex, 0, th * 0.34, th * 0.46, 0, 0, TAU)
    ctx.fill()
    ctx.strokeStyle = 'rgba(120,70,30,0.6)'
    ctx.beginPath()
    ctx.ellipse(ex, 0, th * 0.17, th * 0.24, 0, 0, TAU)
    ctx.stroke()
    if (burning) {
      ctx.globalCompositeOperation = 'lighter'
      ctx.fillStyle = `rgba(255,${90 + Math.round(60 * Math.sin(this.t * 7 + x))},30,${0.35 * burning})`
      roundRect(ctx, -len / 2, -th / 2, len, th, th / 2)
      ctx.fill()
    }
    ctx.restore()
  }

  drawEmbers() {
    const { ctx, cx, by, u } = this
    const I = this.cold ? 0.15 : clamp(this.heat, 0.1, 1.4)
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    for (let i = 0; i < 14; i++) {
      const x = cx + (((i * 37) % 13) - 6) * 13 * u
      const y = by - 3 * u + (((i * 11) % 5) - 2) * 2 * u
      const pulse = this.reduced ? 0.8 : 0.6 + 0.4 * Math.sin(this.t * (1.3 + (i % 4) * 0.4) + i)
      ctx.fillStyle = `rgba(255,${80 + (i % 3) * 30},30,${0.5 * I * pulse})`
      ctx.beginPath()
      ctx.ellipse(x, y, 7 * u, 3.2 * u, 0, 0, TAU)
      ctx.fill()
    }
    ctx.restore()
  }

  drawFlames() {
    const { ctx, cx, u } = this
    if (this.heat < 0.02) return
    const H = this.flameH()
    const W = this.flameW()
    const base = this.flameBase()
    const t = this.reduced ? 1.3 : this.t
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    const layers = [
      { scale: 1, colors: ['rgba(230,60,20,0.0)', 'rgba(232,74,28,0.42)', 'rgba(255,110,36,0.55)'], n: 7 },
      { scale: 0.74, colors: ['rgba(255,140,40,0.0)', 'rgba(255,146,46,0.42)', 'rgba(255,180,70,0.55)'], n: 5 },
      { scale: 0.46, colors: ['rgba(255,220,130,0.0)', 'rgba(255,214,120,0.42)', 'rgba(255,240,190,0.6)'], n: 3 },
    ]
    for (const L of layers) {
      for (let i = 0; i < L.n; i++) {
        const k = L.n === 1 ? 0 : i / (L.n - 1) - 0.5 // -0.5..0.5
        const center = Math.max(0, 1 - Math.abs(k) * 1.6)
        const h = H * L.scale * (0.3 + 0.7 * Math.pow(center, 1.3)) * (0.84 + 0.16 * Math.sin(t * (4.3 + i * 0.9) + i * 1.7))
        const w = W * L.scale * (0.34 + 0.12 * center)
        const x = cx + k * W * L.scale * 1.15
        const sway = Math.sin(t * (2.2 + i * 0.37) + i) * w * 0.35 + Math.sin(t * 7.3 + i * 3) * w * 0.08
        const g = ctx.createLinearGradient(0, base, 0, base - h)
        g.addColorStop(0, L.colors[2])
        g.addColorStop(0.45, L.colors[1])
        g.addColorStop(1, L.colors[0])
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.moveTo(x - w, base)
        ctx.bezierCurveTo(x - w * 1.05, base - h * 0.45, x + sway - w * 0.25, base - h * 0.75, x + sway, base - h)
        ctx.bezierCurveTo(x + sway + w * 0.25, base - h * 0.7, x + w * 1.05, base - h * 0.4, x + w, base)
        ctx.quadraticCurveTo(x, base + w * 0.7, x - w, base)
        ctx.closePath()
        ctx.fill()
      }
    }
    // a hot core at the base
    const core = ctx.createRadialGradient(cx, base, 2, cx, base, W * 0.7)
    core.addColorStop(0, `rgba(255,236,180,${0.4 * Math.min(1, this.heat + 0.2)})`)
    core.addColorStop(1, 'rgba(255,160,60,0)')
    ctx.fillStyle = core
    ctx.beginPath()
    ctx.ellipse(cx, base, W * 0.7, W * 0.35, 0, 0, TAU)
    ctx.fill()
    ctx.restore()
    void u
  }

  drawSparks() {
    const { ctx } = this
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    for (const p of this.sparks) {
      const a = clamp(p.life / 1.2, 0, 1)
      const c = mix([255, 120, 40], [255, 236, 160], p.hot)
      ctx.fillStyle = rgb(c, a)
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r, 0, TAU)
      ctx.fill()
      ctx.fillStyle = rgb(c, a * 0.16)
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r * 2.6, 0, TAU)
      ctx.fill()
    }
    ctx.restore()
  }

  drawSmoke() {
    const { ctx } = this
    for (const p of this.smoke) {
      const life = p.life / p.max
      const a = p.a * Math.sin(Math.PI * clamp(life, 0, 1))
      const c = mix([110, 104, 124], [150, 144, 160], p.tone)
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r)
      g.addColorStop(0, rgb(c, a))
      g.addColorStop(1, rgb(c, 0))
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r, 0, TAU)
      ctx.fill()
    }
    if (this.reduced && this.smokeOut > 0) {
      // a still column instead of drifting puffs
      const { cx, u } = this
      for (let i = 0; i < 7; i++) {
        const y = this.flameBase() - (30 + i * 34) * u
        const r = (26 + i * 9) * u
        const g = ctx.createRadialGradient(cx + i * 8 * u, y, 0, cx + i * 8 * u, y, r)
        g.addColorStop(0, 'rgba(130,124,142,0.3)')
        g.addColorStop(1, 'rgba(130,124,142,0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(cx + i * 8 * u, y, r, 0, TAU)
        ctx.fill()
      }
    }
  }

  drawFlying() {
    for (const f of this.flying) {
      const k = clamp((this.t - f.t0) / f.dur, 0, 1)
      const x = lerp(f.from.x, f.to.x, k)
      const y = lerp(f.from.y, f.to.y, k) - Math.sin(k * Math.PI) * 120 * this.u
      this.ctx.save()
      this.ctx.translate(x, y)
      this.ctx.rotate(f.spin * k)
      this.drawLog(0, 0, 60 * this.u, 13 * this.u, 0, 0.3, false, 0.6, 0, 0)
      this.ctx.restore()
    }
  }

  drawTargetLine() {
    const { ctx, cx, u } = this
    if (this.cold || !this.targetText) return
    const y = this.targetY()
    const half = 150 * u
    const fade = this.markFade
    if (fade < 0.02) return
    ctx.save()
    ctx.globalAlpha = fade
    ctx.lineWidth = 2
    if (this.reached) {
      ctx.strokeStyle = 'rgba(255,214,110,0.9)'
      ctx.setLineDash([])
    } else {
      ctx.strokeStyle = 'rgba(255,214,150,0.75)'
      ctx.setLineDash([7 * u, 6 * u])
    }
    ctx.beginPath()
    ctx.moveTo(cx - half, y)
    ctx.lineTo(cx + half, y)
    ctx.stroke()
    ctx.setLineDash([])
    // little end caps
    ctx.fillStyle = ctx.strokeStyle
    for (const s of [-1, 1]) {
      ctx.beginPath()
      ctx.arc(cx + s * half, y, 3, 0, TAU)
      ctx.fill()
    }
    ctx.restore()
  }

  /**
   * The target's label, on an opaque pill: right of the line if there is room before the card, else
   * over the line's right end if the flames stay clear of it, else not at all (the card says it too).
   * Hidden while a night burns or smokes.
   */
  drawTargetLabel() {
    const { ctx, cx, u } = this
    if (this.cold || !this.targetText || this.markFade < 0.02) return
    const y = this.targetY()
    const half = 150 * u
    const text = this.targetText
    const bg = this.reached ? '#3a2a08' : '#1b1426'
    const fg = this.reached ? '#ffe08a' : '#ffd9a6'
    const limit = (this.layout.free?.r ?? this.W) - 6
    ctx.save()
    ctx.globalAlpha = this.markFade
    // the pile's number at the line's left end, like a ruler: "293 on the pile ---- target 641"
    if (this.pileText) {
      const x = cx - half - 10 * u
      const left = (this.layout.free?.l ?? 0) + 4
      const fits = (t) => x - this.measure(t, 13) - 18 > left
      const text = [this.pileText, `${this.pileShort} wood`].find(fits)
      if (text) this.pill(text, x, y, '#2a1a12', '#ffe2b0', 13, 'right', 1)
      else this.pill(`${this.pileShort} wood`, cx - half, y + 18 * u, '#2a1a12', '#ffe2b0', 12, 'left', 1)
    }
    const right = cx + half + 10 * u
    if (right + this.measure(text, 13) + 18 < limit) this.pill(text, right, y, bg, fg, 13, 'left', 1)
    else {
      const w = this.measure(text, 12) + 16
      const end = Math.min(cx + half, limit)
      const flameEdge = cx + this.flameW() * 1.05
      const flameTip = this.flameBase() - this.flameH()
      if (end - w > flameEdge + 6 || flameTip > y - 4 * u) this.pill(text, end, y - 18 * u, bg, fg, 12, 'right', 1)
    }
    ctx.restore()
  }

  measure(text, size) {
    this.ctx.font = `700 ${size}px ${FONT}`
    return this.ctx.measureText(text).width
  }

  pill(text, x, y, bg, fg, size = 12, align = 'center', opacity = 0.86) {
    const { ctx } = this
    ctx.font = `700 ${size}px ${FONT}`
    const w = ctx.measureText(text).width + size * 1.3
    const h = size * 1.9
    const left = align === 'left' ? x : align === 'right' ? x - w : x - w / 2
    ctx.fillStyle = bg
    ctx.globalAlpha *= opacity
    roundRect(ctx, left, y - h / 2, w, h, h / 2)
    ctx.fill()
    ctx.globalAlpha /= opacity
    ctx.strokeStyle = 'rgba(255,214,150,0.35)'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.fillStyle = fg
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, left + w / 2, y + 0.5)
  }

  drawFloats() {
    const { ctx, u } = this
    for (const f of this.floats) {
      const k = (this.t - f.t0) / f.life
      ctx.save()
      ctx.globalAlpha = 1 - k * k
      ctx.font = `800 ${Math.round(15 * Math.max(0.9, u))}px ${FONT}`
      ctx.textAlign = 'center'
      ctx.fillStyle = '#ffe9b8'
      ctx.shadowColor = 'rgba(255,120,40,0.8)'
      ctx.shadowBlur = 10
      ctx.fillText(f.text, f.x, f.y - k * 40 * u)
      ctx.restore()
    }
  }

  drawVeil() {
    const { ctx, W, H } = this
    if (this.veil > 0.01) {
      ctx.fillStyle = `rgba(52,52,66,${0.36 * this.veil})`
      ctx.fillRect(0, 0, W, H)
    }
    const v = ctx.createRadialGradient(W / 2, H * 0.55, Math.min(W, H) * 0.35, W / 2, H * 0.55, Math.max(W, H) * 0.8)
    v.addColorStop(0, 'rgba(0,0,0,0)')
    v.addColorStop(1, 'rgba(0,0,0,0.5)')
    ctx.fillStyle = v
    ctx.fillRect(0, 0, W, H)
  }

  drawEmptySeats() {
    // two empty log benches: there is room at the fire
    const { ctx, u } = this
    for (const theta of [0.42, Math.PI - 0.42]) {
      const p = this.seatPos(theta)
      ctx.save()
      ctx.translate(p.x, p.y)
      ctx.fillStyle = '#2b1d16'
      roundRect(ctx, -34 * p.s, -9 * p.s, 68 * p.s, 15 * p.s, 7 * p.s)
      ctx.fill()
      ctx.fillStyle = `rgba(255,150,80,${0.3 * this.heat})`
      roundRect(ctx, -34 * p.s, -9 * p.s, 68 * p.s, 5 * p.s, 3 * p.s)
      ctx.fill()
      ctx.restore()
    }
    void u
  }

  drawPerson(seat) {
    const { ctx } = this
    const p = this.seatPos(seat.slot)
    const look = seat.look
    const face = p.x < this.cx ? 1 : -1 // everyone faces the fire
    const s = p.s * look.size
    const appear = this.reduced ? 1 : easeOut(clamp((this.t - seat.born) / 0.6, 0, 1))
    const I = clamp(this.heat, 0.12, 1.4)
    const warm = (p.front ? 0.6 : 0.95) * Math.max(0.5, Math.min(1, I))
    const breathe = this.reduced ? 0 : Math.sin(this.t * 1.3 + look.phase) * 0.7
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.globalAlpha = appear
    ctx.scale(face, 1)
    // the log they sit on
    ctx.fillStyle = '#1e1511'
    roundRect(ctx, -24 * s, -9 * s, 40 * s, 10 * s, 5 * s)
    ctx.fill()
    ctx.fillStyle = `rgba(255,140,70,${0.28 * warm})`
    roundRect(ctx, -24 * s, -9 * s, 40 * s, 3 * s, 2 * s)
    ctx.fill()
    // dark at the back, warm where the fire reaches; a faint cool rim from the sky keeps the shape
    // readable against the dark ground
    const dark = mix([8, 6, 12], [34, 18, 14], p.front ? 0 : 0.35 * warm)
    const lit = mix([12, 9, 16], [214, 108, 52], warm)
    const g = ctx.createLinearGradient(-16 * s, 0, 26 * s, 0)
    g.addColorStop(0, rgb(dark))
    g.addColorStop(0.5, rgb(mix(dark, lit, 0.25)))
    g.addColorStop(1, rgb(lit))
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const P = (x, y) => [x * s, y * s]
    let grow = 0
    let paint = g
    const line = (a, b, w, c) => {
      ctx.strokeStyle = paint
      ctx.lineWidth = (w + grow) * s
      ctx.beginPath()
      ctx.moveTo(...a)
      if (c) ctx.quadraticCurveTo(...c, ...b)
      else ctx.lineTo(...b)
      ctx.stroke()
    }
    const disc = (x, y, r) => {
      ctx.fillStyle = paint
      ctx.beginPath()
      ctx.arc(x, y, r + (grow * s) / 2, 0, TAU)
      ctx.fill()
    }
    const lean = look.lean
    const hip = P(-7, -15)
    const knee = P(13, -22 - look.knee)
    const foot = P(16, -3)
    const shoulder = P(-1 + lean, -43 + breathe)
    const head = P(4 + lean * 1.3, -56 + breathe)
    const [hx, hy] = head
    const pose = look.pose
    const hat = look.hat
    const cheer = this.cheering()
    const wave = this.reduced ? 0 : Math.sin(this.t * 8 + look.phase * 3) * 3
    const figure = () => {
      line(hip, knee, 11)
      line(knee, foot, 8.5)
      line(foot, P(21, -2), 5)
      line(hip, shoulder, 17, P(-9 + lean * 0.4, -30))
      if (cheer > 0.5) {
        // both arms up: the fire caught
        line(P(1 + lean, -41 + breathe), P(9, -55 + wave * 0.3), 6.5)
        line(P(9, -55 + wave * 0.3), P(13, -70 + wave), 5.5)
        line(P(-3 + lean, -41 + breathe), P(-9, -55 - wave * 0.3), 6.5)
        line(P(-9, -55 - wave * 0.3), P(-11, -69 - wave), 5.5)
      } else if (pose === 0) {
        line(P(0 + lean, -40 + breathe), P(12, -32), 6.5)
        line(P(12, -32), P(25, -31 + breathe * 0.5), 5.5)
      } else if (pose === 1) {
        line(P(0 + lean, -40 + breathe), P(11, -29), 6.5)
        line(P(11, -29), P(15, -20), 5.5)
      } else if (pose === 2) {
        line(P(0 + lean, -40 + breathe), P(11, -33), 6.5)
        line(P(11, -33), P(21, -32), 5.5)
      } else {
        line(P(-3 + lean, -40 + breathe), P(-12, -28), 6.5)
        line(P(-12, -28), P(-17, -13), 5.5)
        line(P(1 + lean, -40 + breathe), P(13, -27), 6)
      }
      line(P(1 + lean, -46 + breathe), head, 6)
      if (hat === 2) disc(hx - 2.2 * s, hy - 0.6 * s, 10.6 * s)
      if (hat === 5) line([hx - 4 * s, hy - 5 * s], [hx - 9 * s, hy + 12 * s], 6.5)
      disc(hx, hy, 8.2 * s)
      if (hat === 1) {
        disc(hx - 0.5 * s, hy - 11.5 * s, 3 * s)
        ctx.beginPath()
        ctx.arc(hx - 0.5 * s, hy - 1.5 * s, 8.8 * s + (grow * s) / 2, Math.PI, TAU)
        ctx.fill()
      } else if (hat === 3) {
        ctx.beginPath()
        ctx.arc(hx, hy - 1.5 * s, 8.6 * s + (grow * s) / 2, Math.PI, TAU)
        ctx.fill()
        roundRect(ctx, hx - (grow * s) / 2, hy - 3.5 * s - (grow * s) / 2, 14 * s + grow * s, 3 * s + grow * s, 1.5 * s)
        ctx.fill()
      } else if (hat === 4) {
        disc(hx - 7.5 * s, hy - 5.5 * s, 4.2 * s)
      } else if (hat === 6) {
        ctx.beginPath()
        ctx.ellipse(hx, hy - 5 * s, 15 * s + (grow * s) / 2, 2.8 * s + (grow * s) / 2, 0, 0, TAU)
        ctx.fill()
        roundRect(ctx, hx - 7 * s - (grow * s) / 2, hy - 14 * s - (grow * s) / 2, 14 * s + grow * s, 10 * s + grow * s, 3 * s)
        ctx.fill()
      }
    }
    grow = 2.4
    paint = `rgba(150,160,220,${p.front ? 0.16 : 0.12})`
    figure()
    grow = 0
    paint = g
    figure()
    if (pose === 2 && cheer <= 0.5) {
      // a roasting stick with something on it
      ctx.lineWidth = 1.6 * s
      ctx.strokeStyle = '#1a120d'
      ctx.beginPath()
      ctx.moveTo(...P(18, -30))
      ctx.lineTo(...P(56, -45))
      ctx.stroke()
      ctx.fillStyle = `rgba(255,${200 - Math.round(60 * I)},150,${0.5 + 0.4 * Math.min(1, I)})`
      ctx.beginPath()
      ctx.ellipse(...P(57, -45.5), 3.2 * s, 2.4 * s, -0.35, 0, TAU)
      ctx.fill()
    }
    ctx.restore()
    if (seat.me) {
      const y = p.y + (hy - 22 * s)
      const x = p.x + hx * face
      const bob = this.reduced ? 0 : Math.sin(this.t * 2.4) * 2
      ctx.save()
      ctx.globalAlpha = appear
      this.pill('you', x, y + bob - 6, '#3a2208', '#ffd27a', 11)
      ctx.fillStyle = '#ffd27a'
      ctx.beginPath()
      ctx.moveTo(x - 4, y + bob + 6)
      ctx.lineTo(x + 4, y + bob + 6)
      ctx.lineTo(x, y + bob + 11)
      ctx.fill()
      ctx.restore()
    }
  }

  drawMore() {
    if (this.more <= 0) return
    const { u } = this
    this.ctx.save()
    this.ctx.globalAlpha = 0.9
    this.pill(`+${this.more} more around the fire`, this.cx, this.by + 66 * u + 26 * u, '#140f1c', 'rgba(255,226,196,0.75)', 11)
    this.ctx.restore()
  }

}

function lookFor(seed) {
  const r = rng(seed || hashSeed('x'))
  return {
    size: 0.88 + r() * 0.24,
    hat: Math.floor(r() * 7),
    pose: Math.floor(r() * 4),
    lean: (r() - 0.35) * 5,
    knee: (r() - 0.5) * 5,
    phase: r() * TAU,
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/**
 * A still of the fire, drawn off screen: a lit night's roar or a smoky night, with figures around
 * it, for the share card and the link preview. `seats` as for setSeats; `layout` as for setLayout.
 */
export function renderStill({ width, height, kind = 'lit', seats = [], pct = 1.15, layout = {}, seconds = 1.6, reducedMotion = false }) {
  const canvas = document.createElement('canvas')
  const s = new Scene(canvas, { size: { width, height, dpr: 1 }, reducedMotion })
  s.setLayout({ cx: 0.5, by: 0.8, scale: 1, ...layout })
  s.setNight({ progress: 0.995, pct, reached: kind === 'lit', pileText: '', targetText: '' })
  s.setSeats(seats, 0)
  s.frame(1 / 30)
  s.outcome(kind)
  const steps = Math.round(seconds * 30)
  for (let i = 0; i < steps; i++) s.step(1 / 30)
  s.draw()
  return canvas
}
