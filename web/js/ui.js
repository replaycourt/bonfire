// DOM helpers: the strip of last nights, the supply chart, records, the proof drawer and the
// "How it works" text. Everything that comes from the chain goes in through textContent or esc().
import { fmtDuration, fmtEmber, fmtFactor, fmtInt, fmtPct, toWhole } from './logic.js'

export const $ = (id) => document.getElementById(id)
const SVG = 'http://www.w3.org/2000/svg'

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function svgEl(name, attrs = {}, parent) {
  const el = document.createElementNS(SVG, name)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  parent?.appendChild(el)
  return el
}

export function setText(id, text) {
  const el = $(id)
  if (el && el.textContent !== text) el.textContent = text
}

// ---- toast --------------------------------------------------------------------------------------

let toastTimer = null
export function toast(text, kind = 'info', ms = 4200) {
  const el = $('toast')
  el.textContent = text
  el.className = `toast ${kind}`
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (el.hidden = true), ms)
}

// ---- the strip of last nights -------------------------------------------------------------------

const ICONS = {
  lit: 'M12 2.5c.9 3.2 4.6 5.2 4.6 9.5a4.6 4.6 0 0 1-9.2 0c0-2.2 1.3-3.5 2.2-4.6.3 1.5.9 2.4 1.8 2.8-.3-2.8 0-5.6.6-7.7z',
  smoke: 'M7.5 17a3.5 3.5 0 0 1-.6-6.95A5 5 0 0 1 16.4 8.6 3.6 3.6 0 0 1 17 17H7.5z',
  empty: 'M6 16.5h12M7.5 19h9',
}

export function renderStrip(el, strip, { decimals, symbol, max = 24 }) {
  el.replaceChildren()
  if (!strip.length) {
    const li = document.createElement('li')
    li.className = 'strip-empty'
    li.textContent = 'The first night is still burning'
    el.appendChild(li)
    return
  }
  const rows = strip.slice(-max)
  for (const n of rows) {
    const li = document.createElement('li')
    li.className = `night ${n.outcome}`
    const word = n.outcome === 'lit' ? 'caught fire' : n.outcome === 'smoke' ? 'went up in smoke' : 'stayed cold'
    li.title = `Night ${n.night} ${word}: ${fmtEmber(n.pile, decimals)} of ${fmtEmber(n.target, decimals)} ${symbol}`
    li.setAttribute('aria-label', li.title)
    const svg = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, li)
    if (n.outcome === 'empty') svgEl('path', { d: ICONS.empty, class: 'stroke' }, svg)
    else svgEl('path', { d: ICONS[n.outcome] }, svg)
    const bar = document.createElement('span')
    bar.className = 'bar'
    const fill = document.createElement('i')
    fill.style.setProperty('--h', `${Math.round(Math.min(1.5, n.pct) / 1.5 * 100)}%`)
    bar.appendChild(fill)
    li.appendChild(bar)
    el.appendChild(li)
  }
}

// ---- the supply chart ---------------------------------------------------------------------------

/**
 * Supply after every settled night: one series, a 2 px line over a 10 % wash, three hairline
 * gridlines, a crosshair and a tooltip on hover and on arrow keys.
 */
export function renderChart(host, series, { symbol }) {
  host.replaceChildren()
  if (series.length < 2) {
    const p = document.createElement('p')
    p.className = 'chart-empty'
    p.textContent = series.length ? 'One night so far. The line starts tomorrow.' : 'No night has ended yet. The line starts at the first dawn.'
    host.appendChild(p)
    return
  }
  const W = Math.max(280, host.clientWidth || 560)
  const H = Math.max(190, Math.min(320, host.clientHeight || 190))
  const pad = { l: 58, r: 14, t: 14, b: 26 }
  const xs = series.map((d) => d.night)
  const ys = series.map((d) => d.supply)
  let lo = Math.min(...ys)
  let hi = Math.max(...ys)
  const span = hi - lo || hi * 0.01 || 1
  lo -= span * 0.08
  hi += span * 0.08
  const x = (n) => pad.l + ((n - xs[0]) / (xs[xs.length - 1] - xs[0])) * (W - pad.l - pad.r)
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b)
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'chart-svg', tabindex: '0', role: 'img', 'aria-label': `${symbol} supply after each night, from night ${xs[0]} to night ${xs[xs.length - 1]}` }, host)
  const ticks = [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1]
  for (const v of ticks) {
    svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'grid' }, svg)
    const t = svgEl('text', { x: pad.l - 8, y: y(v) + 4, class: 'axis', 'text-anchor': 'end' }, svg)
    t.textContent = compactNumber(v)
  }
  for (const [n, anchor] of [
    [xs[0], 'start'],
    [xs[xs.length - 1], 'end'],
  ]) {
    const t = svgEl('text', { x: x(n), y: H - 6, class: 'axis', 'text-anchor': anchor }, svg)
    t.textContent = `night ${n}`
  }
  const pts = series.map((d) => `${x(d.night).toFixed(1)},${y(d.supply).toFixed(1)}`)
  svgEl('path', { d: `M${pts[0]} L${pts.join(' L')} L${x(xs[xs.length - 1]).toFixed(1)},${H - pad.b} L${pad.l},${H - pad.b} Z`, class: 'area' }, svg)
  svgEl('path', { d: `M${pts.join(' L')}`, class: 'line' }, svg)
  const last = series[series.length - 1]
  svgEl('circle', { cx: x(last.night), cy: y(last.supply), r: 4, class: 'end-dot' }, svg)

  const cross = svgEl('line', { y1: pad.t, y2: H - pad.b, class: 'cross', visibility: 'hidden' }, svg)
  const dot = svgEl('circle', { r: 4.5, class: 'hover-dot', visibility: 'hidden' }, svg)
  const tip = document.createElement('div')
  tip.className = 'chart-tip'
  tip.hidden = true
  host.appendChild(tip)
  let index = series.length - 1
  const show = (i) => {
    index = Math.max(0, Math.min(series.length - 1, i))
    const d = series[index]
    const cx = x(d.night)
    cross.setAttribute('x1', cx)
    cross.setAttribute('x2', cx)
    cross.setAttribute('visibility', 'visible')
    dot.setAttribute('cx', cx)
    dot.setAttribute('cy', y(d.supply))
    dot.setAttribute('visibility', 'visible')
    tip.replaceChildren()
    const v = document.createElement('b')
    v.textContent = `${fmtInt(Math.round(d.supply))} ${symbol}`
    const s = document.createElement('span')
    s.textContent = `Night ${d.night} · ${d.outcome === 'lit' ? 'lit' : d.outcome === 'smoke' ? 'smoke' : 'cold'}`
    tip.append(v, s)
    tip.hidden = false
    const scale = host.clientWidth / W || 1
    tip.style.setProperty('--x', `${Math.round(cx * scale)}px`)
    tip.classList.toggle('flip', cx * scale > host.clientWidth * 0.6)
  }
  const hide = () => {
    cross.setAttribute('visibility', 'hidden')
    dot.setAttribute('visibility', 'hidden')
    tip.hidden = true
  }
  svg.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * W
    let best = 0
    for (let i = 1; i < series.length; i++) if (Math.abs(x(series[i].night) - px) < Math.abs(x(series[best].night) - px)) best = i
    show(best)
  })
  svg.addEventListener('pointerleave', hide)
  svg.addEventListener('focus', () => show(index))
  svg.addEventListener('blur', hide)
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') show(index - 1)
    else if (e.key === 'ArrowRight') show(index + 1)
  })
  // the same numbers as a table, for screen readers
  const table = document.createElement('table')
  table.className = 'sr-only'
  const head = table.insertRow()
  for (const h of ['Night', 'Outcome', `Supply (${symbol})`]) {
    const th = document.createElement('th')
    th.textContent = h
    head.appendChild(th)
  }
  for (const d of series.slice(-60)) {
    const row = table.insertRow()
    for (const v of [d.night, d.outcome, fmtInt(Math.round(d.supply))]) row.insertCell().textContent = String(v)
  }
  host.appendChild(table)
}

function compactNumber(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 1 : 3).replace(/\.?0+$/, '') + 'M'
  if (v >= 1e4) return Math.round(v / 1e3) + 'k'
  return fmtInt(Math.round(v))
}

// ---- proof drawer -------------------------------------------------------------------------------

export function proofHtml({ mock, contract, keys, codeHash, account, gasAccount, rpcHost, txs, explorer, deployed }) {
  const link = (path, text) => (mock ? `<code>${esc(text)}</code>` : `<a href="${esc(explorer)}/${path}" target="_blank" rel="noopener">${esc(text)}</a>`)
  const keyLine =
    keys == null
      ? '<span class="muted">checking…</span>'
      : !deployed
        ? '<span class="muted">not deployed yet</span>'
        : keys.length === 0
          ? '<b class="good">0 access keys</b> <span class="muted">· nobody can change the rules</span>'
          : `<b class="bad">${keys.length} access key${keys.length === 1 ? '' : 's'}</b> <span class="muted">· not locked yet</span>`
  const rows = txs.length
    ? txs
        .map(
          (t) =>
            `<li><span class="kind">${esc(t.kind)}</span>${mock ? `<code>${esc(t.hash.slice(0, 12))}…</code>` : `<a href="${esc(explorer)}/txns/${esc(t.hash)}" target="_blank" rel="noopener"><code>${esc(t.hash.slice(0, 12))}…</code></a>`}${t.failure ? ' <b class="bad">failed</b>' : ''}<span class="gas">${(t.gas / 1e12).toFixed(1)} Tgas</span></li>`,
        )
        .join('')
    : '<li class="muted">No transactions from this tab yet.</li>'
  return `
    ${mock ? '<p class="mock-note">Mock mode: made-up data in this tab. Nothing below is on chain.</p>' : ''}
    <p>Everything on this page is read from NEAR ${mock ? '(here: a stand-in)' : 'testnet'}. Your moves are transactions signed by a key this browser made; a public gas pool pays the fees.</p>
    <ul class="proof-list">
      <li><span>Contract</span>${link(`address/${contract}`, contract)}</li>
      <li><span>Its keys</span><span>${keyLine}</span></li>
      <li><span>Code hash</span><code>${esc(codeHash ?? '–')}</code></li>
      <li><span>You</span>${link(`address/${account}`, account)}</li>
      <li><span>Gas paid by</span><code>${esc(gasAccount)}</code></li>
      <li><span>RPC</span><code>${esc(rpcHost)}</code></li>
    </ul>
    <h3>Your transactions</h3>
    <ul class="tx-list">${rows}</ul>
    <h3>Check the keys yourself</h3>
    <pre class="rpc">{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"${esc(contract)}"}}</pre>
    <p class="muted">Send it to any NEAR testnet RPC: <code>"keys":[]</code> means no one, not even its author, can change the contract.</p>`
}

// ---- how it works -------------------------------------------------------------------------------

export function howHtml(cfg) {
  const c = cfg.config
  const d = c.decimals
  const sym = esc(c.symbol)
  const amt = (u) => `${fmtEmber(u, d)} ${sym}`
  const keep = 100 - Number(c.hearth_cut_bp) / 100
  return `
    <ol class="how-list">
      <li><b>One night, one pile.</b> A night lasts ${esc(fmtDuration(Number(c.night_ms)))}. Throw ${sym} on the pile before dawn; it is locked until the night ends.</li>
      <li><b>Lit.</b> If the pile reaches the target, all wood goes back and ${fmtPct(c.mint_bp)} of the target is minted as new ${sym}: ${keep} % to the throwers by weight, the rest to the hearth. The next target is ${fmtPct(c.grow_bp)} higher.</li>
      <li><b>Smoke.</b> If it falls short, ${fmtPct(c.smoke_bp)} of the pile burns and the rest goes back. The hearth burns ${fmtPct(c.hearth_burn_bp)}. The next target is ${fmtPct(c.shrink_bp)} lower.</li>
      <li><b>Early wood earns more.</b> Wood counts ${fmtFactor(c.early_max_bp)} at dusk, falling to ×1 at dawn. Wood thrown after the pile is already big enough counts ${fmtFactor(c.late_lit_bp)}.</li>
      <li><b>Kindling.</b> Newcomers get ${amt(c.kindling)} from the hearth, once, ${fmtInt(c.kindling_per_night)} per night.</li>
      <li><b>No owner.</b> Every rule above is fixed at launch. The contract account has no keys, so nobody can change it. Open <i>Proof</i> to check.</li>
      <li><b>No wallet.</b> Your browser holds a key for an implicit account and signs your moves; a public gas pool relays them. Clearing site data loses that key.</li>
    </ol>
    <p class="muted fine">Splitting ${sym} over many accounts earns nothing extra: rewards follow wood and timing, not accounts. Kindling is the one per-account gift, so it is capped per night and paid from a finite hearth.</p>`
}

// ---- drawer -------------------------------------------------------------------------------------

let lastFocus = null
export function openDrawer(title, html) {
  lastFocus = document.activeElement
  setText('drawer-title', title)
  $('drawer-body').innerHTML = html
  $('drawer').hidden = false
  $('drawer-backdrop').hidden = false
  $('drawer-close').focus()
}

export function closeDrawer() {
  $('drawer').hidden = true
  $('drawer-backdrop').hidden = true
  lastFocus?.focus?.()
}

export const drawerOpen = () => !$('drawer').hidden

export { fmtEmber, toWhole }
