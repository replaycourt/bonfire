// The page's promises about itself: a strict CSP that matches the configured RPC hosts, mock mode off
// unless asked for, and nothing private in any shipped file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTRACT, DEPLOYMENTS, GAS_ACCOUNT, GAS_KEYS, RPC_HOSTS, pickDeployment } from '../js/config.js'
import { b58decode, keyFromNearString, nearPublicKey } from '../js/near.js'

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

// The only private keys a shipped file may hold: the public function-call gas keys in config.js.
const PUBLIC_GAS_SECRETS = new Set(Object.values(DEPLOYMENTS).flatMap((d) => d.gasKeys.map((k) => k.private_key)))

test('every gas key is a well-formed ed25519 pair whose secret matches its public key', async () => {
  for (const [name, d] of Object.entries(DEPLOYMENTS)) {
    const pubs = new Set()
    for (const k of d.gasKeys) {
      assert.deepEqual(Object.keys(k).sort(), ['private_key', 'public_key'], `${name}: only the two key strings`)
      assert.match(k.public_key, /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/)
      assert.match(k.private_key, /^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/)
      assert.equal(b58decode(k.private_key.slice(8)).length, 64)
      assert.equal(nearPublicKey(await keyFromNearString(k.private_key)), k.public_key, `${name}: secret and public key belong together`)
      assert.ok(!pubs.has(k.public_key), `${name}: no key twice`)
      pubs.add(k.public_key)
    }
  }
})

test('the staging deployment is ready to play: its gas pool and its code hash are filled in', () => {
  const stage = DEPLOYMENTS.stage
  assert.ok(stage.gasKeys.length > 0)
  assert.match(stage.codeHash, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/)
  assert.equal(b58decode(stage.codeHash).length, 32, 'a base58 sha256')
})

test('the final deployment is the default and complete: its gas pool, the committed wasm hash, five labelled bots', () => {
  const final = DEPLOYMENTS.final
  assert.equal(pickDeployment('').contract, 'bonfire-coin.testnet')
  assert.equal(final.gasKeys.length, 8)
  const pinned = readFileSync(join(WEB, '..', 'contract', 'WASM_SHA256'), 'utf8').trim()
  assert.equal(Buffer.from(b58decode(final.codeHash)).toString('hex'), pinned, 'codeHash is contract/WASM_SHA256 in base58')
  assert.deepEqual(Object.values(final.bots).sort(), ['demo-bot-early-a', 'demo-bot-early-b', 'demo-bot-idle', 'demo-bot-late', 'demo-bot-steady'])
  const stageKeys = new Set(DEPLOYMENTS.stage.gasKeys.map((k) => k.public_key))
  assert.ok(final.gasKeys.every((k) => !stageKeys.has(k.public_key)), 'its own keys, not staging ones')
})

test('every deployment labels its demo bots: implicit accounts, each called demo-bot-something', () => {
  for (const [name, d] of Object.entries(DEPLOYMENTS)) {
    assert.equal(typeof d.bots, 'object', `${name}: a bots map, empty until deployment`)
    for (const [account, label] of Object.entries(d.bots)) {
      assert.match(account, /^[0-9a-f]{64}$/, `${name}: ${account}`)
      assert.match(label, /^demo-bot-[a-z-]+$/, `${name}: ${label}`)
      assert.ok(label.length <= 18, 'short enough to stand on the card unshortened')
    }
  }
  assert.equal(Object.keys(DEPLOYMENTS.stage.bots).length, 5, 'the five demo bots of docs/testnet-stage.md')
})

test('no file holds a local path, a user name, an e-mail address or a private key', () => {
  const bad = [
    /\/Users\/|\/home\/|C:\\\\Users/,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/,
    /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/, // a NEAR private key string (seed + public key)
    /BEGIN [A-Z ]*PRIVATE KEY/,
  ]
  for (const f of files(WEB)) {
    if (!/\.(js|mjs|html|css|svg|json|md)$/.test(f)) continue
    let text = readFileSync(f, 'utf8')
    // the public gas keys are allowed in config.js, and only there
    if (f === join(WEB, 'js/config.js')) for (const secret of PUBLIC_GAS_SECRETS) text = text.replace(`private_key: '${secret}'`, 'private_key: <public gas key>')
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
