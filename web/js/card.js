// The share card: a 1200x630 picture of the player's night, drawn in the browser on a canvas: the
// fire as the scene draws it (renderStill), the coin's face the contract drew (ft_metadata().icon),
// the night in words and the page's address. Shared as a PNG through the share sheet where the browser
// has one, else saved; nothing is sent anywhere by the page. The link preview (og.jpg) is drawn by the
// same code (drawPoster), from web/og/.
import { fmtEmber, hashSeed } from './logic.js'
import { FONT as SCENE_FONT, renderStill } from './scene.js'

const W = 1200
const H = 630
const FONT = SCENE_FONT

/** The card's words for a night the player threw on (nightResult with `mine`), or null. */
export function cardText(result, symbol, decimals) {
  if (!result?.mine) return null
  const f = (u) => fmtEmber(u, decimals)
  const many = (result.throwers ?? 0) > 1
  if (result.outcome === 'LIT') {
    return {
      kicker: `NIGHT ${result.night} · ${result.word}`,
      title: many ? `${result.throwers} of us lit night ${result.night}` : `I lit night ${result.night}`,
      line: `My ${f(result.mine.wood)} wood came back, plus ${f(result.mine.reward)} new ${symbol}.`,
    }
  }
  if (result.outcome === 'SMOKED') {
    return {
      kicker: `NIGHT ${result.night} · SMOKED`,
      title: `Night ${result.night} went up in smoke`,
      line: many ? `${result.throwers} of us threw, not enough. ${f(result.mine.lost)} ${symbol} of my wood burned.` : `${f(result.mine.lost)} ${symbol} of my wood burned. Back tomorrow night.`,
    }
  }
  return null
}

/** What goes with a shared card: a title, a line that names the night, and the page's address. */
export function shareText(result, { symbol = 'EMBER', decimals = 18, url = '' } = {}) {
  const t = cardText(result, symbol, decimals)
  if (!t) return null
  const text = result.outcome === 'LIT' ? `${t.title} on Bonfire (${result.word}). Throw wood on tonight's fire:` : `${t.title} on Bonfire. Help light tonight's fire:`
  return { title: `Bonfire · night ${result.night}`, text, url }
}

/** The address as the card prints it: no scheme, no trailing slash. */
export const shortUrl = (url) => String(url ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '')

async function fontsIn() {
  try {
    await Promise.all(['900 64px', '800 30px', '700 28px'].map((w) => document.fonts?.load(`${w} "Bonfire Display"`)))
  } catch {
    /* the fallback faces draw the card */
  }
}

/** A few anonymous figures for a card drawn without the page's own circle. */
function crowd(n, me = false) {
  return Array.from({ length: n }, (_, i) => ({ account: `seat-${i}`, seed: hashSeed(`bonfire-${i * 7 + 3}`), me: me && i === 1 }))
}

/** The fire, the darkened left side for the words, and the brand row on top. */
function background(g, { kind, seats, cx = 0.73, scale = 1.18, left = 650 }) {
  // the circle stays right of the words
  const fire = renderStill({ width: W, height: H, kind, seats, pct: kind === 'lit' ? 1.2 : 0.7, layout: { cx, by: 0.86, scale, flameTop: 24, free: { l: left, r: W - 8 } } })
  g.drawImage(fire, 0, 0)
  const shade = g.createLinearGradient(0, 0, W * 0.62, 0)
  shade.addColorStop(0, 'rgba(8, 6, 14, 0.94)')
  shade.addColorStop(0.62, 'rgba(8, 6, 14, 0.72)')
  shade.addColorStop(1, 'rgba(8, 6, 14, 0)')
  g.fillStyle = shade
  g.fillRect(0, 0, W, H)
}

function wordmark(g, x, y, size) {
  g.font = `900 ${size}px ${FONT}`
  g.textBaseline = 'alphabetic'
  const grad = g.createLinearGradient(0, y - size * 0.8, 0, y)
  grad.addColorStop(0.1, '#fff1c8')
  grad.addColorStop(0.6, '#ffb55a')
  grad.addColorStop(1, '#ff7a2a')
  g.save()
  g.shadowColor = 'rgba(255, 140, 50, 0.45)'
  g.shadowBlur = size * 0.3
  g.fillStyle = grad
  g.fillText('Bonfire', x, y)
  g.restore()
  return g.measureText('Bonfire').width
}

/** Draws the card; resolves to a canvas. `icon` is a data: URI or null; `seats` as the scene has them. */
export async function drawCard({ result, icon, symbol, decimals, seats = null, url = 'https://replaycourt.github.io/bonfire/web/' }) {
  const t = cardText(result, symbol, decimals)
  if (!t) return null
  await fontsIn()
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')
  const lit = result.outcome === 'LIT'
  const circle = seats?.length ? seats.map((s) => ({ account: s.account, seed: s.seed, me: !!s.me })) : crowd(Math.min(8, Math.max(3, result.throwers ?? 4)), true)
  background(g, { kind: lit ? 'lit' : 'smoked', seats: circle })
  // brand row: the coin's face, as the contract drew it (already passed through safeIcon), and the name
  let x = 64
  if (typeof icon === 'string' && icon.startsWith('data:image/')) {
    try {
      const img = new Image()
      img.src = icon
      await img.decode()
      g.save()
      roundRect(g, x, 52, 64, 64, 15)
      g.clip()
      g.drawImage(img, x, 52, 64, 64)
      g.restore()
      x += 82
    } catch {
      /* the name carries the row without the face */
    }
  }
  wordmark(g, x, 102, 50)
  g.textBaseline = 'alphabetic'
  g.fillStyle = lit ? '#ffc861' : '#c9c5d8'
  g.font = `800 25px ${FONT}`
  spaced(g, t.kicker, 64, 214, 3)
  g.fillStyle = '#fff3e2'
  g.font = `900 60px ${FONT}`
  const y = wrap(g, t.title, 64, 288, 610, 66)
  g.fillStyle = 'rgba(255, 236, 214, 0.86)'
  g.font = `700 28px ${FONT}`
  wrap(g, t.line, 64, y + 54, 560, 38)
  g.fillStyle = '#ffc861'
  g.font = `800 30px ${FONT}`
  g.fillText(shortUrl(url), 64, 556)
  g.fillStyle = 'rgba(255, 226, 196, 0.62)'
  g.font = `700 21px ${FONT}`
  g.fillText('A memecoin you light together · play free, no wallet', 64, 592)
  return c
}

/** The link preview: the lit fire, the name and the line, nothing of any one night. */
export async function drawPoster() {
  await fontsIn()
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')
  background(g, { kind: 'lit', seats: crowd(8), cx: 0.74, scale: 1.25, left: 640 })
  wordmark(g, 60, 250, 150)
  g.fillStyle = '#fff3e2'
  g.font = `800 48px ${FONT}`
  g.fillText('a memecoin you', 66, 344)
  g.fillText('light together', 66, 402)
  g.fillStyle = '#ffc861'
  g.font = `800 28px ${FONT}`
  spaced(g, 'PLAY FREE · NO WALLET', 66, 506, 2)
  g.fillStyle = 'rgba(255, 226, 196, 0.7)'
  g.font = `700 24px ${FONT}`
  g.fillText(`${shortUrl('https://replaycourt.github.io/bonfire/web/')} · NEAR testnet`, 66, 552)
  return c
}

/** Text with letter spacing, for the kicker lines (canvas letterSpacing where the browser has it). */
function spaced(g, text, x, y, px) {
  if ('letterSpacing' in g) {
    g.letterSpacing = `${px}px`
    g.fillText(text, x, y)
    g.letterSpacing = '0px'
  } else g.fillText(text, x, y)
}

/** Fills `text` in lines of at most `width`; returns the last line's baseline. */
function wrap(g, text, x, y, width, lineHeight) {
  const words = text.split(' ')
  let line = ''
  for (const w of words) {
    const next = line ? `${line} ${w}` : w
    if (g.measureText(next).width > width && line) {
      g.fillText(line, x, y)
      line = w
      y += lineHeight
    } else line = next
  }
  if (line) g.fillText(line, x, y)
  return y
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath()
  g.moveTo(x + r, y)
  g.arcTo(x + w, y, x + w, y + h, r)
  g.arcTo(x + w, y + h, x, y + h, r)
  g.arcTo(x, y + h, x, y, r)
  g.arcTo(x, y, x + w, y, r)
  g.closePath()
}

async function toBlob(opts) {
  const canvas = await drawCard(opts)
  if (!canvas) return null
  return new Promise((res) => canvas.toBlob(res, 'image/png'))
}

function download(blob, name) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

/**
 * Shares the card: the PNG through the share sheet (Web Share with files) where the browser offers
 * it, else a download. Resolves to 'shared', 'cancelled', 'saved' or false.
 */
export async function shareCard(opts) {
  const blob = await toBlob(opts)
  if (!blob) return false
  const name = `bonfire-night-${opts.result.night}.png`
  const t = shareText(opts.result, opts)
  const file = typeof File === 'function' ? new File([blob], name, { type: 'image/png' }) : null
  const data = { files: file ? [file] : [], title: t.title, text: t.text, url: t.url }
  if (file && globalThis.navigator?.canShare?.(data)) {
    try {
      await navigator.share(data)
      return 'shared'
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled'
      /* the share sheet refused: save it instead */
    }
  }
  download(blob, name)
  return 'saved'
}

/** Saves the card as bonfire-night-N.png. */
export async function saveCard(opts) {
  const blob = await toBlob(opts)
  if (!blob) return false
  download(blob, `bonfire-night-${opts.result.night}.png`)
  return true
}
