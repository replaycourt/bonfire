#!/usr/bin/env node
// Draws the share card the dawn banner offered the take's visitor ("Save your card"), with the page's
// own code: nightResult (web/js/logic.js) and drawCard (web/js/card.js), in headless Chrome. The data
// is read from the chain as it stood at a block of that dawn: night(n), the visitor's holder entry
// (still uncollected) and ft_metadata().icon, the coin's face the contract drew then. Past blocks
// need an archival RPC.
//
//   node demo/video/tools/card.mjs --take <take dir> --night <n> --block <block hash> [--profile <dir>]
//        [--port 9431] [--serve-port 8811]
//
// Pick a block after night n settled and before the visitor collected, e.g. the block of the
// visitor's collect transaction (its receipt runs one block later). Writes into the take directory:
//   card-<n>.png    the card, 1200x630, exactly as the page would save it
//   card-<n>.json   what it was drawn from
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchChrome, Page } from './cdp.mjs'
import { serve } from './serve.mjs'
import { DEPLOYMENTS } from '../../../web/js/config.js'

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : dflt
}
const TAKE = resolve(arg('take', 'take'))
const NIGHT = Number(arg('night', 0))
const BLOCK = arg('block', null)
const PORT = Number(arg('port', 9431))
const SERVE_PORT = Number(arg('serve-port', 8811))
const PROFILE = resolve(arg('profile', join(TAKE, 'card-profile')))
const ARCHIVE = process.env.BONFIRE_ARCHIVAL_RPC || 'https://archival-rpc.testnet.fastnear.com'
const D = DEPLOYMENTS.final
if (!NIGHT || !BLOCK) throw new Error('--night and --block are required')

const take = JSON.parse(readFileSync(join(TAKE, 'take.json'), 'utf8'))
async function view(method, args) {
  const r = await fetch(ARCHIVE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', block_id: BLOCK, account_id: D.contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }),
    signal: AbortSignal.timeout(15000),
  })
  const j = await r.json()
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 300)}`)
  return JSON.parse(Buffer.from(j.result.result).toString())
}
const [night, holder, meta, cfg] = await Promise.all([view('night', { n: NIGHT }), view('holder', { account_id: take.visitor }), view('ft_metadata', {}), view('config', {})])
const input = { contract: D.contract, block: BLOCK, visitor: take.visitor, night, holder, icon: meta.icon, symbol: cfg.config.symbol, decimals: cfg.config.decimals }

const server = await serve(ROOT, SERVE_PORT)
const chrome = await launchChrome({ port: PORT, profileDir: PROFILE, width: 1280, height: 720, extraArgs: ['--force-color-profile=srgb', '--font-render-hinting=none', '--mute-audio'] })
const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
const page = new Page(ws, chrome)
try {
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Page.navigate', { url: `${server.url}web/js/card.js` }) // any page of the site's origin
  await page.waitFor(() => document.readyState === 'complete', 15000)
  const out = await page.eval(async (inp, labels) => {
    const L = await import('/web/js/logic.js')
    const { drawCard, cardText } = await import('/web/js/card.js')
    const result = L.nightResult(inp.night, inp.holder, inp.visitor, inp.decimals, inp.symbol, labels)
    const canvas = await drawCard({ result, icon: inp.icon, symbol: inp.symbol, decimals: inp.decimals })
    return canvas ? { png: canvas.toDataURL('image/png'), text: cardText(result, inp.symbol, inp.decimals) } : null
  }, input, D.bots)
  if (!out) throw new Error(`no card: the visitor had no wood on night ${NIGHT} at that block`)
  writeFileSync(join(TAKE, `card-${NIGHT}.png`), Buffer.from(out.png.split(',')[1], 'base64'))
  writeFileSync(join(TAKE, `card-${NIGHT}.json`), JSON.stringify({ ...input, text: out.text }, null, 1))
  console.log(`card-${NIGHT}.png: ${JSON.stringify(out.text)}`)
} finally {
  await page.close().catch(() => {})
  chrome.kill()
  server.close()
}
process.exit(0)
