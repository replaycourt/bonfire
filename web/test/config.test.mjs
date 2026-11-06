// The page's promises about itself: a strict CSP that matches the configured RPC hosts, mock mode off
// unless asked for, and nothing private in any shipped file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTRACT, DEPLOYMENTS, GAS_ACCOUNT, GAS_KEYS, RPC_HOSTS, pickDeployment } from '../js/config.js'

const WEB = fileURLToPath(new URL('..', import.meta.url))
const html = readFileSync(join(WEB, 'index.html'), 'utf8')
const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1]
const directive = (name) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' '))

test('the CSP is strict and connects only to the configured RPC hosts', () => {
  assert.equal(directive('default-src'), "default-src 'self'")
  assert.equal(directive('script-src'), "script-src 'self'")
  assert.equal(directive('style-src'), "style-src 'self'")
  assert.equal(directive('img-src'), "img-src 'self' data:")
  assert.equal(directive('object-src'), "object-src 'none'")
  assert.deepEqual(directive('connect-src').split(/\s+/).slice(1).sort(), [...RPC_HOSTS].sort())
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp))
  for (const h of RPC_HOSTS) assert.match(h, /^https:\/\/[a-z0-9.-]+$/)
})

test('one config module names the deployments: the final contract by default, staging on request', () => {
  assert.equal(CONTRACT, 'bonfire-coin.testnet')
  assert.equal(GAS_ACCOUNT, 'bonfire-gas.testnet')
  assert.ok(Array.isArray(GAS_KEYS))
  assert.equal(pickDeployment('?contract=stage').contract, 'bonfire-stage.testnet')
  assert.equal(pickDeployment('?contract=final').contract, 'bonfire-coin.testnet')
  assert.equal(pickDeployment('?contract=evil.testnet').contract, 'bonfire-coin.testnet', 'only known names')
  assert.equal(pickDeployment('?contract=__proto__').name, 'final')
  assert.equal(pickDeployment('').name, 'final')
  for (const d of Object.values(DEPLOYMENTS)) {
    assert.match(d.contract, /^[a-z0-9-]+\.testnet$/)
    assert.ok(Array.isArray(d.gasKeys))
  }
})

test('mock mode needs ?mock=1 and is loaded only then', () => {
  const main = readFileSync(join(WEB, 'js/main.js'), 'utf8')
  assert.match(main, /const MOCK = params\.get\('mock'\) === '1'/)
  assert.ok(!/^import .*mock\.js/m.test(main), 'mock.js is not imported statically')
  assert.match(main, /if \(MOCK\) \{\s+const \{ MockClient \} = await import\('\.\/mock\.js'\)/)
})

function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : [p]
  })
}

test('no file holds a local path, a user name, an e-mail address or a private key', () => {
  const bad = [
    /\/Users\/|\/home\/|C:\\\\Users/,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/,
    /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/, // a NEAR private key string (seed + public key)
    /BEGIN [A-Z ]*PRIVATE KEY/,
  ]
  for (const f of files(WEB)) {
    if (!/\.(js|mjs|html|css|svg|json|md)$/.test(f)) continue
    const text = readFileSync(f, 'utf8')
    for (const re of bad) assert.ok(!re.test(text), `${f.slice(WEB.length)} matches ${re}`)
  }
})

test('no inline script or style that the CSP would block', () => {
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'no inline <script>')
  assert.ok(!/<style\b/.test(html), 'no <style> element')
  assert.ok(!/\sstyle="/.test(html), 'no style attributes')
  assert.ok(!/\son[a-z]+="/.test(html), 'no inline event handlers')
  for (const f of files(join(WEB, 'js'))) {
    const text = readFileSync(f, 'utf8')
    assert.ok(!/style="/.test(text), `${f.slice(WEB.length)} writes no style attributes into HTML`)
  }
})
