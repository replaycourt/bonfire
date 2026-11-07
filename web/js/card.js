// The share card: a 1200x630 picture of the player's night, with the coin's face the contract drew
// (ft_metadata().icon) at its heart. Made in the browser on a canvas and saved as a PNG; nothing is
// sent anywhere.
import { fmtEmber } from './logic.js'

const W = 1200
const H = 630
const FONT = 'ui-rounded, "SF Pro Rounded", "Nunito", "Avenir Next", "Segoe UI", system-ui, sans-serif'

/** The card's words for a night the player threw on (nightResult with `mine`), or null. */
export function cardText(result, symbol, decimals) {
  if (!result?.mine) return null
  const f = (u) => fmtEmber(u, decimals)
  if (result.outcome === 'LIT') {
    return {
      kicker: `NIGHT ${result.night} · ${result.word}`,
      title: `I helped light night ${result.night}`,
      line: `My ${f(result.mine.wood)} wood came back, plus ${f(result.mine.reward)} new ${symbol}.`,
    }
  }
  if (result.outcome === 'SMOKED') {
    return {
      kicker: `NIGHT ${result.night} · SMOKED`,
      title: `Night ${result.night} went up in smoke`,
      line: `${f(result.mine.lost)} ${symbol} of my wood burned. Back tomorrow night.`,
    }
  }
  return null
}

/** Draws the card; resolves to a canvas. `icon` is a data: URI or null. */
export async function drawCard({ result, icon, symbol, decimals }) {
  const t = cardText(result, symbol, decimals)
  if (!t) return null
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')
  const lit = result.outcome === 'LIT'
  const sky = g.createLinearGradient(0, 0, 0, H)
  sky.addColorStop(0, '#0b0814')
  sky.addColorStop(1, lit ? '#3a1a0c' : '#1b1b24')
  g.fillStyle = sky
  g.fillRect(0, 0, W, H)
  const glow = g.createRadialGradient(300, 330, 20, 300, 330, 360)
  glow.addColorStop(0, lit ? 'rgba(255, 150, 60, 0.55)' : 'rgba(170, 165, 190, 0.3)')
  glow.addColorStop(1, 'rgba(0, 0, 0, 0)')
  g.fillStyle = glow
  g.fillRect(0, 0, W, H)
  if (icon) {
    try {
      const img = new Image()
      img.src = icon
      await img.decode()
      g.drawImage(img, 120, 150, 360, 360)
    } catch {
      /* the words carry the card without the face */
    }
  }
  g.textBaseline = 'alphabetic'
  g.fillStyle = lit ? '#ffc861' : '#c9c5d8'
  g.font = `800 26px ${FONT}`
  g.fillText(t.kicker, 540, 210)
  g.fillStyle = '#fff3e2'
  g.font = `800 58px ${FONT}`
  wrap(g, t.title, 540, 285, 600, 66)
  g.fillStyle = 'rgba(255, 236, 214, 0.82)'
  g.font = `600 30px ${FONT}`
  wrap(g, t.line, 540, 430, 600, 40)
  g.fillStyle = 'rgba(255, 226, 196, 0.55)'
  g.font = `600 22px ${FONT}`
  g.fillText('Bonfire · a memecoin you light together · NEAR testnet', 540, 560)
  return c
}

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
}

/** Saves the card as bonfire-night-N.png. */
export async function saveCard(opts) {
  const canvas = await drawCard(opts)
  if (!canvas) return false
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'))
  if (!blob) return false
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `bonfire-night-${opts.result.night}.png`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  return true
}
