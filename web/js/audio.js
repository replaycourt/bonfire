// A tiny WebAudio synth: a crackling fire, a thud for thrown wood, a roar for a lit night, a hiss for
// smoke. It comes on with the first tap on "Get kindling" (a tap is what browsers wait for before
// they play anything), unless the player chose before; the speaker button turns it on and off, and
// the choice is remembered.

const STORE = 'bonfire:sound'
const VOLUME = 0.6

export class Sound {
  /** `store` is a { get, set } that never throws (logic.js safeStore), or null to remember nothing. */
  constructor(store = null) {
    this.store = store
    this.ctx = null
    this.master = null
    const c = store?.get(STORE) ?? null
    this.choice = c === 'on' || c === 'off' ? c : null // null: the player has not chosen
    this.on = this.choice === 'on'
    this.crackleTimer = null
    this.heat = 0.3
  }

  setOn(on) {
    this.on = on
    this.choice = on ? 'on' : 'off'
    this.store?.set(STORE, this.choice)
    if (on) this.enable()
    if (this.master) this.master.gain.linearRampToValueAtTime(on ? VOLUME : 0, this.ctx.currentTime + 0.25)
    if (on) this.crackleLoop()
  }

  enable() {
    if (this.ctx) return
    try {
      this.ctx = new (globalThis.AudioContext || globalThis.webkitAudioContext)()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.on ? VOLUME : 0
      this.master.connect(this.ctx.destination)
      this.noise = this.makeNoise()
      this.bed()
      if (this.on) this.crackleLoop()
    } catch {
      this.ctx = null
    }
  }

  makeNoise() {
    const c = this.ctx
    const buf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
    return buf
  }

  /** A low, soft rumble of burning wood under everything. */
  bed() {
    const c = this.ctx
    const src = c.createBufferSource()
    src.buffer = this.noise
    src.loop = true
    const lp = c.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 260
    this.bedGain = c.createGain()
    this.bedGain.gain.value = 0.05
    src.connect(lp).connect(this.bedGain).connect(this.master)
    src.start()
  }

  setHeat(h) {
    this.heat = h
    if (this.bedGain && this.ctx) this.bedGain.gain.linearRampToValueAtTime(0.03 + 0.09 * Math.min(h, 1.6), this.ctx.currentTime + 0.5)
  }

  crackleLoop() {
    clearTimeout(this.crackleTimer)
    const next = () => {
      if (!this.on) return
      this.crackle()
      this.crackleTimer = setTimeout(next, 60 + Math.random() * (900 / (0.4 + this.heat)))
    }
    next()
  }

  burstNoise({ dur = 0.03, gain = 0.2, freq = 2500, q = 1, type = 'bandpass', delay = 0, attack = 0.002 }) {
    if (!this.ctx || !this.on) return
    const c = this.ctx
    const t = c.currentTime + delay
    const src = c.createBufferSource()
    src.buffer = this.noise
    const f = c.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    f.Q.value = q
    const g = c.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(gain, t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(f).connect(g).connect(this.master)
    src.start(t, Math.random())
    src.stop(t + dur + 0.05)
  }

  tone({ freq, type = 'sine', dur = 0.2, gain = 0.2, slide = 0, delay = 0 }) {
    if (!this.ctx || !this.on) return
    const c = this.ctx
    const t = c.currentTime + delay
    const o = c.createOscillator()
    const g = c.createGain()
    o.type = type
    o.frequency.setValueAtTime(freq, t)
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(g).connect(this.master)
    o.start(t)
    o.stop(t + dur + 0.02)
  }

  crackle() {
    const n = 1 + Math.floor(Math.random() * 3)
    for (let i = 0; i < n; i++) this.burstNoise({ dur: 0.015 + Math.random() * 0.03, gain: 0.05 + Math.random() * 0.12, freq: 1500 + Math.random() * 3500, q: 2, delay: i * 0.025 })
  }

  thud() {
    this.tone({ freq: 120, type: 'sine', dur: 0.22, gain: 0.25, slide: -60 })
    this.burstNoise({ dur: 0.12, gain: 0.12, freq: 700, q: 0.7 })
    for (let i = 0; i < 4; i++) this.burstNoise({ dur: 0.02, gain: 0.08, freq: 3000 + Math.random() * 2000, q: 2, delay: 0.08 + i * 0.05 })
  }

  roar() {
    this.burstNoise({ dur: 2.8, gain: 0.32, freq: 500, q: 0.6, type: 'lowpass', attack: 0.5 })
    this.tone({ freq: 70, type: 'sine', dur: 2.2, gain: 0.18, slide: 30 })
    for (let i = 0; i < 18; i++) this.burstNoise({ dur: 0.02, gain: 0.1, freq: 2500 + Math.random() * 3000, q: 2, delay: 0.3 + Math.random() * 2 })
    ;[392, 494, 587, 784].forEach((f, i) => this.tone({ freq: f, type: 'triangle', dur: 0.6, gain: 0.05, delay: 0.25 + i * 0.12 }))
  }

  hiss() {
    this.burstNoise({ dur: 2.4, gain: 0.16, freq: 5200, q: 0.4, type: 'highpass', attack: 0.3 })
    this.tone({ freq: 196, type: 'triangle', dur: 0.9, gain: 0.05, slide: -70, delay: 0.2 })
  }

  chime() {
    this.tone({ freq: 660, type: 'triangle', dur: 0.5, gain: 0.08 })
    this.tone({ freq: 990, type: 'triangle', dur: 0.7, gain: 0.06, delay: 0.14 })
  }

  refuse() {
    this.tone({ freq: 300, type: 'triangle', dur: 0.18, gain: 0.06, slide: -90 })
  }
}
