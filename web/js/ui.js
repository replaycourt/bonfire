// DOM helpers: the strip of last nights, the supply chart, records, the proof drawer and the
// "How it works" text. Everything that comes from the chain goes in through textContent or esc().
import { fmtDuration, fmtEmber, fmtFactor, fmtFixed, fmtInt, fmtPct, fmtWhole, nameOf, toWhole } from './logic.js'

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
  LIT: 'M12 2.5c.9 3.2 4.6 5.2 4.6 9.5a4.6 4.6 0 0 1-9.2 0c0-2.2 1.3-3.5 2.2-4.6.3 1.5.9 2.4 1.8 2.8-.3-2.8 0-5.6.6-7.7z',
  SMOKED: 'M7.5 17a3.5 3.5 0 0 1-.6-6.95A5 5 0 0 1 16.4 8.6 3.6 3.6 0 0 1 17 17H7.5z',
  COLD: 'M12 7.2a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 1 0 0-9.6z',
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
  for (const n of strip.slice(-max)) {
    const li = document.createElement('li')
    li.className = `night ${n.outcome.toLowerCase()}`
    li.title = `Night ${n.night} · ${n.word} · ${fmtWhole(n.pile, decimals)} of ${fmtWhole(n.target, decimals)} ${symbol}`
    li.setAttribute('aria-label', li.title)
    const svg = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, li)
    svgEl('path', { d: ICONS[n.outcome] ?? ICONS.COLD }, svg)
    const cap = document.createElement('span')
    cap.className = 'cap'
    cap.textContent = n.outcome === 'LIT' ? `×${n.streak}` : ''
    li.appendChild(cap)
    el.appendChild(li)
  }
}

// ---- the night's quarters -----------------------------------------------------------------------

/** The hero's small bar: one segment per window, the current one filling as time passes. */
export function renderQuarters(el, win, now) {
  if (el.childElementCount !== win.count) {
    el.replaceChildren()
    for (let i = 0; i < win.count; i++) {
      const seg = document.createElement('span')
      seg.appendChild(document.createElement('i'))
      el.appendChild(seg)
    }
  }
  win.segments.forEach((sg, i) => {
    const seg = el.children[i]
    seg.className = `q ${sg.when}`
    const p = sg.when === 'past' ? 1 : sg.when === 'now' ? Math.min(1, Math.max(0, (now - sg.startMs) / (sg.endMs - sg.startMs))) : 0
    seg.firstChild.style.setProperty('--p', `${(p * 100).toFixed(1)}%`)
  })
  el.setAttribute('aria-label', win.due ? 'The night is over' : `Quarter ${win.current + 1} of ${win.count}`)
}

/**
 * The Tonight card's windows: each window's wood as a bar and the factor its wood earns; the
 * current window marked "now".
 */
export function renderWindows(el, win, now, { decimals }) {
  if (el.childElementCount !== win.count) {
    el.replaceChildren()
    for (let i = 0; i < win.count; i++) {
      const col = document.createElement('div')
      col.className = 'w'
      const bar = document.createElement('div')
      bar.className = 'w-bar'
      bar.appendChild(document.createElement('i'))
      const mine = document.createElement('b')
      mine.className = 'w-mine'
      bar.appendChild(mine)
      const l = document.createElement('span')
      l.className = 'w-label'
      col.append(bar, l)
      el.appendChild(col)
    }
  }
  const most = win.segments.reduce((m, sg) => (sg.wood > m ? sg.wood : m), 0n)
  win.segments.forEach((sg, i) => {
    const col = el.children[i]
    col.className = `w ${sg.when}`
    const h = most > 0n ? Number((sg.wood * 1000n) / most) / 10 : 0
    col.firstChild.firstChild.style.setProperty('--h', `${sg.wood > 0n ? Math.max(8, h) : 0}%`)
    col.firstChild.children[1].hidden = sg.mine <= 0n
    // past windows show what their wood earns, the current one says "now", later ones their name
    col.children[1].textContent = sg.when === 'now' ? 'now' : sg.when === 'past' ? (sg.factorBp == null ? '–' : fmtFactor(sg.factorBp)) : `Q${i + 1}`
    col.title = `Quarter ${i + 1}: ${fmtWhole(sg.wood, decimals)} wood${sg.factorBp != null ? `, counts ${fmtFactor(sg.factorBp)}` : ''}${sg.mine > 0n ? ', yours among it' : ''}`
  })
  void now
}

// ---- the supply chart ---------------------------------------------------------------------------

/** "+0.018 %": the change of v against base, with enough decimals to tell small moves apart. */
export function pctChange(v, base) {
  const pct = base ? ((v - base) / base) * 100 : 0
  const a = Math.abs(pct)
  const digits = a === 0 ? 0 : a < 0.1 ? 3 : a < 10 ? 2 : 1
  const text = a.toFixed(digits)
  return `${Number(text) === 0 ? '±' : pct > 0 ? '+' : '−'}${text} %`
}

/** The next round number at or above v (1, 2, 2.5, 5 times a power of ten), for the axis. */
export function niceCeil(v) {
  if (!(v > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((n) => n >= v - 1e-9)
}

const amount = (v) => v.toLocaleString('en-US', { maximumFractionDigits: v < 10 ? 2 : 1 })

/**
 * What the nights did to the supply: one column per night, EMBER minted above the line (a lit
 * night) and burned below it (smoke, and the hearth's share), lit streaks as faint bands behind
 * them; a tooltip on hover and on the arrow keys, and the numbers as a table for screen readers.
 */
export function renderFlows(host, series, { symbol }) {
  host.replaceChildren()
  if (!series.length) {
    const p = document.createElement('p')
    p.className = 'chart-empty'
    p.textContent = 'No night has ended yet. The bars start at the first dawn.'
    host.appendChild(p)
    return
  }
  const W = Math.max(280, host.clientWidth || 560)
  const H = Math.max(200, Math.min(300, host.clientHeight || 200))
  const pad = { l: 44, r: 8, t: 12, b: 24 }
  const top = niceCeil(Math.max(...series.map((d) => d.mint)))
  const bot = niceCeil(Math.max(...series.map((d) => d.burn)))
  const plotH = H - pad.t - pad.b
  const zero = pad.t + (plotH * top) / (top + bot)
  const y = (v) => zero - (v / (top + bot)) * plotH
  const slot = (W - pad.l - pad.r) / series.length
  const bw = Math.max(2, Math.min(24, slot - 2))
  const cx = (i) => pad.l + slot * (i + 0.5)
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'chart-svg', tabindex: '0', role: 'img', 'aria-label': `${symbol} minted and burned in each night, from night ${series[0].night} to night ${series[series.length - 1].night}` }, host)
  // lit streaks of two nights or more, as faint bands
  for (let i = 0; i < series.length; ) {
    let j = i
    while (j < series.length && series[j].outcome === 'LIT') j++
    if (j - i >= 2) svgEl('rect', { x: pad.l + slot * i, y: pad.t, width: slot * (j - i), height: plotH, rx: 4, class: 'band' }, svg)
    i = Math.max(j, i + 1)
  }
  for (const [v, label] of [
    [top, `+${amount(top)}`],
    [-bot, `−${amount(bot)}`],
  ]) {
    svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'grid' }, svg)
    svgEl('text', { x: pad.l - 8, y: y(v) + 4, class: 'axis', 'text-anchor': 'end' }, svg).textContent = label
  }
  svgEl('text', { x: pad.l - 8, y: zero + 4, class: 'axis', 'text-anchor': 'end' }, svg).textContent = '0'
  const hover = svgEl('rect', { y: pad.t, width: slot, height: plotH, rx: 4, class: 'hover-band', visibility: 'hidden' }, svg)
  // a column grows from the line; its far end is rounded
  const bar = (i, v, kind) => {
    const h = Math.max(1.5, Math.abs(y(v) - zero))
    const x0 = cx(i) - bw / 2
    const x1 = x0 + bw
    const r = Math.min(4, bw / 2, h)
    const e = kind === 'mint' ? zero - h : zero + h
    const k = kind === 'mint' ? r : -r
    svgEl('path', { d: `M${x0},${zero} L${x0},${e + k} Q${x0},${e} ${x0 + r},${e} L${x1 - r},${e} Q${x1},${e} ${x1},${e + k} L${x1},${zero} Z`, class: `bar ${kind}` }, svg)
  }
  series.forEach((d, i) => {
    if (d.mint > 0) bar(i, d.mint, 'mint')
    if (d.burn > 0) bar(i, -d.burn, 'burn')
  })
  svgEl('line', { x1: pad.l, x2: W - pad.r, y1: zero, y2: zero, class: 'zero' }, svg)
  for (const [i, anchor] of [
    [0, 'start'],
    [series.length - 1, 'end'],
  ]) {
    svgEl('text', { x: anchor === 'start' ? pad.l : W - pad.r, y: H - 6, class: 'axis', 'text-anchor': anchor }, svg).textContent = `night ${series[i].night}`
  }
  const tip = document.createElement('div')
  tip.className = 'chart-tip'
  tip.hidden = true
  host.appendChild(tip)
  let index = series.length - 1
  const show = (i) => {
    index = Math.max(0, Math.min(series.length - 1, i))
    const d = series[index]
    hover.setAttribute('x', pad.l + slot * index)
    hover.setAttribute('visibility', 'visible')
    tip.replaceChildren()
    const head = document.createElement('b')
    head.textContent = `Night ${d.night} · ${d.word}`
    const lines = [d.mint > 0 && `+${amount(d.mint)} ${symbol} minted`, d.burn > 0 && `−${amount(d.burn)} ${symbol} burned`, !d.mint && !d.burn && 'nothing minted or burned', `supply after: ${fmtInt(Math.round(d.supply))}`].filter(Boolean)
    tip.append(head, ...lines.map((t) => Object.assign(document.createElement('span'), { textContent: t })))
    tip.hidden = false
    const scale = host.clientWidth / W || 1
    const px = cx(index)
    tip.style.setProperty('--x', `${Math.round(px * scale)}px`)
    tip.classList.toggle('flip', px * scale > host.clientWidth * 0.6)
  }
  const hide = () => {
    hover.setAttribute('visibility', 'hidden')
    tip.hidden = true
  }
  svg.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * W
    show(Math.floor((px - pad.l) / slot))
  })
  svg.addEventListener('pointerleave', hide)
  svg.addEventListener('focus', () => show(index))
  svg.addEventListener('blur', hide)
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') show(index - 1)
    else if (e.key === 'ArrowRight') show(index + 1)
  })
  // the same numbers as a table, for screen readers (in a box: a table grows to fit its cells)
  const box = document.createElement('div')
  box.className = 'sr-only'
  const table = document.createElement('table')
  box.appendChild(table)
  const head = table.insertRow()
  for (const h of ['Night', 'Outcome', `Minted (${symbol})`, `Burned (${symbol})`, `Supply after (${symbol})`]) {
    const th = document.createElement('th')
    th.textContent = h
    head.appendChild(th)
  }
  for (const d of series) {
    const row = table.insertRow()
    for (const v of [d.night, d.word, amount(d.mint), amount(d.burn), fmtInt(Math.round(d.supply))]) row.insertCell().textContent = String(v)
  }
  host.appendChild(box)
}

// ---- the ledger ---------------------------------------------------------------------------------

/**
 * The ledger table: one row per settled night, newest first (rows from ledgerRows). history() has
 * no transaction hashes, so each row links to the contract account's activity on the explorer; in
 * mock mode there is nothing to link to.
 */
export function ledgerHtml(rows, { decimals, explorer, contract, mock }) {
  if (!rows.length) return '<p class="ledger-empty">No night has ended yet. The first row appears at the first dawn.</p>'
  const f = (u) => esc(fmtFixed(u, decimals))
  const w = (u) => esc(fmtWhole(u, decimals))
  const dash = '<span class="muted">–</span>'
  const link = mock
    ? () => dash
    : (n) => `<a href="${esc(explorer)}/address/${esc(contract)}" target="_blank" rel="noopener" title="The contract's activity on the explorer (the rows have no single transaction)" aria-label="Night ${n}: the contract's activity on the explorer">↗</a>`
  const body = rows
    .map((r) => {
      const o = r.outcome.toLowerCase()
      const minted = r.minted > 0n ? `+${f(r.minted)}${r.hearthCut !== null ? `<small>${f(r.shared)} to throwers · ${f(r.hearthCut)} to the hearth</small>` : ''}` : dash
      const burned = r.burned > 0n ? `−${f(r.burned)}${r.hearthBurn !== null ? `<small>${f(r.pileBurn)} pile smoke · ${f(r.hearthBurn)} hearth</small>` : ''}` : dash
      return `<tr class="${esc(o)}"><td data-label="Night">${r.night}</td><td data-label="Outcome"><span class="tag ${esc(o)}">${esc(r.word)}</span></td><td data-label="Target">${w(r.target)}</td><td data-label="Pile">${r.pile > 0n ? w(r.pile) : dash}</td><td data-label="Minted" class="num mint">${minted}</td><td data-label="Burned" class="num burn">${burned}</td><td data-label="Supply after" class="num">${f(r.supply)}</td><td class="link">${link(r.night)}</td></tr>`
    })
    .join('')
  return `<table class="ledger"><thead><tr><th scope="col">Night</th><th scope="col">Outcome</th><th scope="col">Target</th><th scope="col">Pile</th><th scope="col" class="num">Minted</th><th scope="col" class="num">Burned</th><th scope="col" class="num">Supply after</th><th scope="col"><span class="sr-only">Explorer</span></th></tr></thead><tbody>${body}</tbody></table>`
}

/** Where the same numbers live on chain: the NEP-297 events, and links to see them. */
export function ledgerEventsHtml({ explorer, contract, mock }) {
  const links = mock
    ? ' <span class="muted">(mock mode: nothing on chain to link to)</span>'
    : ` See them under the <a href="${esc(explorer)}/token/${esc(contract)}" target="_blank" rel="noopener">token's transfers</a> or the <a href="${esc(explorer)}/address/${esc(contract)}" target="_blank" rel="noopener">contract's activity</a>.`
  return `Every mint and burn is also a NEP-297 event in the receipt of the call that settled the night: <code>ft_mint</code> with memo <code>night N lit</code>, <code>ft_burn</code> with <code>night N smoke</code> and <code>night N hearth smoke</code>.${links}`
}

/** The books in one line, from ledgerCheck: genesis + minted - burned = supply. */
export function ledgerCheckHtml(c, { decimals, symbol }) {
  const f = (u) => esc(fmtFixed(u, decimals))
  const sum = `${f(c.genesis)} genesis + ${f(c.minted)} minted − ${f(c.burned)} burned = <b>${f(c.genesis + c.minted - c.burned)}</b>`
  return c.ok
    ? `${sum}, the supply of ${esc(symbol)} now <span class="good">✓</span>`
    : `${sum}, but the supply is ${f(c.supply)} <span class="bad">✗ the books do not add up</span>`
}

// ---- proof drawer -------------------------------------------------------------------------------

const ACTION_WORDS = { throw: 'throw', claim_kindling: 'kindling', collect: 'collect', transfer: 'transfer' }

/**
 * What one transaction of this tab was, in words: "act · throw", "collect for demo-bot-late", and
 * whether the contract refused it (an act whose outcome said no is a transaction that went through).
 * Returns { kind, mark, why } with `mark` 'refused', 'failed' or null.
 */
export function txLabel(t, me, labels = {}) {
  let kind = t.kind
  if (t.kind === 'act' && ACTION_WORDS[t.action]) kind = `act · ${ACTION_WORDS[t.action]}`
  if (t.kind === 'collect' && t.for && t.for !== me) kind = `collect for ${nameOf(t.for, me, labels)}`
  const mark = t.failure ? 'failed' : t.refused != null ? 'refused' : null
  return { kind, mark, why: mark === 'refused' ? t.refused : null }
}

function txHtml(t, { mock, explorer, account, labels }) {
  const l = txLabel(t, account, labels)
  const hash = mock ? `<code>${esc(t.hash.slice(0, 12))}…</code>` : `<a href="${esc(explorer)}/txns/${esc(t.hash)}" target="_blank" rel="noopener"><code>${esc(t.hash.slice(0, 12))}…</code></a>`
  const mark = l.mark ? ` <b class="bad">${l.mark}</b>` : ''
  const why = l.why ? `<span class="why">${esc(l.why)}</span>` : ''
  return `<li><span class="kind">${esc(l.kind)}${mark}</span>${hash}<span class="gas">${(t.gas / 1e12).toFixed(1)} Tgas</span>${why}</li>`
}

export function proofHtml({ mock, deployment, contract, keys, codeHash, expectedHash = null, account, gasAccount, rpcHost, txs, explorer, deployed, owed, cheats = null, cheatOut = null, lockTx = null, labels = {} }) {
  const link = (path, text) => (mock ? `<code>${esc(text)}</code>` : `<a href="${esc(explorer)}/${path}" target="_blank" rel="noopener">${esc(text)}</a>`)
  const keyLine =
    keys == null
      ? '<span class="muted">checking…</span>'
      : !deployed
        ? '<span class="muted">not deployed yet</span>'
        : keys.length === 0
          ? '<b class="good">0 access keys</b> <span class="muted">· nobody can change the rules</span>'
          : `<b class="bad">${keys.length} access key${keys.length === 1 ? '' : 's'}</b> <span class="muted">· not locked yet</span>`
  // the hash view_account reports, against the one this page was built for (contract/WASM_SHA256)
  const hashLine = !codeHash
    ? `<span class="muted">${keys == null ? 'checking…' : '–'}</span>`
    : `<code>${esc(codeHash)}</code>${!expectedHash ? '' : codeHash === expectedHash ? ' <span class="good">· matches the build in the repository</span>' : ` <b class="bad">· not the build this page expects (${esc(expectedHash)})</b>`}`
  const owedLine = !owed
    ? ''
    : owed.nights === 0
      ? '<span>nothing <span class="muted">· every thrower of a settled night has collected</span></span>'
      : `<span>${esc(owed.amount)} EMBER <span class="muted">to throwers of ${owed.nights} settled night${owed.nights === 1 ? '' : 's'}, until they collect</span></span>`
  const rows = txs.length ? txs.map((t) => txHtml(t, { mock, explorer, account, labels })).join('') : '<li class="muted">No transactions from this tab yet.</li>'
  return `
    ${mock ? '<p class="mock-note">Mock mode: made-up data in this tab. Nothing below is on chain.</p>' : ''}
    <p>Everything on this page is read from NEAR ${mock ? '(here: a stand-in)' : 'testnet'}. Your moves are transactions signed by a key this browser made; a public gas pool pays the fees. Its keys may only call <code>act</code>, <code>settle</code> and <code>collect</code>.</p>
    <ul class="proof-list">
      <li><span>Contract</span><span>${link(`address/${contract}`, contract)}${deployment === 'stage' ? ' <span class="muted">(staging)</span>' : ''}</span></li>
      <li><span>Its keys</span><span>${keyLine}</span></li>
      <li><span>Code hash</span><span>${hashLine}</span></li>
      ${lockTx && !mock ? `<li><span>Locked</span><span>${link(`txns/${lockTx}`, `${lockTx.slice(0, 10)}…`)} <span class="muted">· the last key deleted 16 s into night 1; with no key since, the code cannot have changed</span></span></li>` : ''}
      <li><span>You</span><span>${link(`address/${account}`, account)}</span></li>
      <li><span>Gas paid by</span><code>${esc(gasAccount)}</code></li>
      <li><span>RPC</span><code>${esc(rpcHost)}</code></li>
      ${owed ? `<li><span>Owed</span>${owedLine}</li>` : ''}
    </ul>
    ${cheatHtml(cheats, mock, explorer, cheatOut)}
    <h3>Your transactions</h3>
    <ul class="tx-list">${rows}</ul>
    ${txs.some((t) => t.kind === 'collect' && t.for && t.for !== account) ? '<p class="muted">A <i>collect for</i> is one this page relayed for another thrower of a settled night: anyone may collect for anyone, and it moves EMBER only to its owner.</p>' : ''}
    <h3>Check the keys yourself</h3>
    <pre class="rpc">{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"${esc(contract)}"}}</pre>
    <p class="muted">Send it to any NEAR testnet RPC: <code>"keys":[]</code> means no one, not even its author, can change the contract.</p>`
}

/** A replayed act refused on bonfire-stage.testnet, which runs the same code (docs/testnet-stage.md, tx 54). */
const REPLAY_TX = 'EFxtQKPvpQbXzA63MSiXBPgKa4B5rVVuFCtZRHteVJv3'

/**
 * "Try to cheat it": buttons that send a real transaction breaking a rule, so a visitor sees the
 * contract refuse it. `cheats` is {canAct, kindlingTwice}; kindling twice only makes sense after a
 * first claim (before it, the claim is allowed).
 */
function cheatHtml(cheats, mock, explorer, out = null) {
  if (mock || !cheats) return ''
  const off = (on) => (on ? '' : ' disabled')
  const said = !out
    ? ''
    : out.pending
      ? '<p class="cheat-out" role="status">Sent. Waiting for the contract’s answer…</p>'
      : out.ok
        ? '<p class="cheat-out bad" role="status">That went through, which it should not have. Please report it.</p>'
        : `<p class="cheat-out good" role="status">Refused, as it should be. The contract said: “${esc(out.error ?? 'no')}”</p>`
  return `
    <h3>Try to cheat it</h3>
    <p class="muted">Each button sends a real transaction that breaks a rule. Watch the contract refuse it: its answer shows under the buttons, and the transaction is marked <i>refused</i> under your transactions.</p>
    <div class="cheats">
      <button type="button" class="cheat" data-cheat="future"${off(cheats.canAct)}>Throw wood on tomorrow’s fire</button>
      <button type="button" class="cheat" data-cheat="kindling"${off(cheats.canAct && cheats.kindlingTwice)}>Claim kindling a second time</button>
    </div>
    ${said}
    ${cheats.kindlingTwice ? '' : '<p class="muted">The second claim unlocks after your first kindling.</p>'}
    <p class="muted">Sending the same signed action twice was refused on the staging contract, which runs the same code: <a href="${esc(explorer)}/txns/${REPLAY_TX}" target="_blank" rel="noopener"><code>nonce already used</code></a>.</p>`
}

// ---- how it works -------------------------------------------------------------------------------

export function howHtml(cfg) {
  const c = cfg.config
  const d = c.decimals
  const sym = esc(c.symbol)
  const amt = (u) => `${fmtEmber(u, d)} ${sym}`
  const keep = 100 - Number(c.hearth_cut_bp) / 100
  const quarter = c.pool_windows === 4 ? 'quarter' : 'window'
  return `
    <ol class="how-list">
      <li><b>One night, one pile.</b> A night lasts ${esc(fmtDuration(Number(c.night_ms)))}. Throw ${sym} on the pile before dawn; it is locked until the night ends.</li>
      <li><b>LIT.</b> If the pile reaches the target, all wood comes back and ${fmtPct(c.mint_bp)} of the target is minted as new ${sym}: ${keep} % to the throwers by weight, the rest to the hearth. The next target is ${fmtPct(c.grow_bp)} higher.</li>
      <li><b>SMOKED.</b> If it falls short, ${fmtPct(c.smoke_bp)} of the pile burns and the rest comes back. The hearth burns ${fmtPct(c.hearth_burn_bp)}, at most one night's mint. The next target is ${fmtPct(c.shrink_bp)} lower. <b>COLD</b>: no wood, nothing burns, the target shrinks.</li>
      <li><b>Wood on a cold pile earns most.</b> Wood counts ${fmtFactor(c.early_max_bp)} on an empty pile, falling to ×1 at the target, and ${fmtFactor(c.late_lit_bp)} above it. The night has ${c.pool_windows} ${quarter}s: wood thrown in the same ${quarter} shares its spot in the pile, so being first in a block wins nothing.</li>
      <li><b>Names.</b> The first to throw is the night's <i>Firestarter</i>; the throw that reaches the target is the <i>Last Log</i>.</li>
      <li><b>Collecting.</b> Dawn only records what each thrower is owed. It is credited with your next move, or with one tap; anyone may collect for anyone.</li>
      <li><b>Kindling.</b> A newcomer gets ${amt(c.kindling)} from the hearth, once. The hearth pays ${Number(c.kindling_per_night) === 1 ? 'one claim' : `${fmtInt(c.kindling_per_night)} claims`} a night, first come, first served.</li>
      <li><b>No owner, no wallet.</b> Every rule is fixed at launch and the contract account has no keys (open <i>Proof</i> to check). Your browser holds a key for an implicit account and signs your moves; a public gas pool relays them. Clearing site data loses that key.</li>
    </ol>
    <p class="muted fine">Splitting ${sym} over many accounts earns nothing extra: rewards follow wood and its ${quarter}, not accounts. Kindling is the one per-account gift, so it is capped per night and paid from a finite hearth.</p>`
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
