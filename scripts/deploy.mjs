#!/usr/bin/env node
// Deploys the Bonfire wasm to a testnet account and calls `new` in the same transaction, with the
// testnet launch values of sim/params.json and five demo bots as founders; verifies the deployment;
// and, asked to, locks the account by deleting every access key.
//
//   node scripts/deploy.mjs <account> [--wasm <path>] [--set <field>=<value> ...] [--max-accounts <n>]
//                           [--reserve <NEAR>] [--lock | --verify-only | --lock-only]
//
// - The wasm defaults to contract/target/near/bonfire.wasm (what contract/build.sh prints). It must
//   match contract/WASM_SHA256.
// - The account signs with its full-access key from the legacy keychain (~/.near-credentials/testnet).
// - --set changes one launch value of the testnet block, e.g. --set kindling_per_night=4 or
//   --set hearth_genesis=3000000000000000000000000 (amounts in base units). Repeatable.
// - max_accounts: the testnet value of sim/params.json, lowered so the worst-case storage stake
//   (contract/README.md, "Storage") fits the account's balance minus --reserve (default 0.1 NEAR).
//   --max-accounts sets it explicitly; it is still refused if the stake would not fit.
// - Founders: five demo bot implicit accounts. Their ed25519 keys are generated here and saved to
//   the git-ignored .secrets/bots-<account>.json (mode 600); the hearth genesis is in the config.
// - After deploying it verifies: the code hash on chain equals contract/WASM_SHA256; config() equals
//   the intended values field by field; founders, hearth, total supply and audit(); state() at
//   night 1; and that the deployer's full-access key is the only key.
// - --lock deploys, verifies, and only if every check passed deletes every access key, then waits
//   until view_access_key_list returns no keys. It cannot be undone. Never on staging.
// - --verify-only and --lock-only skip the deployment and verify (and lock) a deployed, untouched
//   contract; give the same --set values and --max-accounts as for the deployment.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  Signer, accessKeys, assertTestnet, b58encode, deleteKeyAction, deployContractAction, functionCallAction,
  keyFromKeychain, near, nearPublicKey, rpc, tgas, view, viewAccount,
} from './near-lite.mjs'
import { Player, ROOT, TGAS, botsFile, ember, readJson, sleep, writeSecret } from './bonfire-lib.mjs'

const argv = process.argv.slice(2)
const opt = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const opts = (name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []))
const account = argv[0]
const modes = ['--lock', '--verify-only', '--lock-only'].filter((m) => argv.includes(m))
if (!account || account.startsWith('--') || modes.length > 1) {
  console.error('usage: deploy.mjs <account> [--wasm <path>] [--set <field>=<value> ...] [--max-accounts <n>] [--reserve <NEAR>] [--lock | --verify-only | --lock-only]')
  process.exit(64)
}
assertTestnet(account)
const deploy = !argv.includes('--verify-only') && !argv.includes('--lock-only')
const lock = argv.includes('--lock') || argv.includes('--lock-only')
const wasmPath = opt('--wasm') ?? join(ROOT, 'contract', 'target', 'near', 'bonfire.wasm')
const reserve = BigInt(Math.round(Number(opt('--reserve') ?? '0.1') * 1e6)) * 10n ** 18n

const code = readFileSync(wasmPath)
const sha = createHash('sha256').update(code).digest()
const codeHash = b58encode(sha)
const pinnedHex = readFileSync(join(ROOT, 'contract', 'WASM_SHA256'), 'utf8').trim()
const pinnedHash = b58encode(Buffer.from(pinnedHex, 'hex'))
console.log(`wasm ${wasmPath.replace(ROOT + '/', '')}: ${code.length} bytes, sha256 ${sha.toString('hex')}, code hash ${codeHash}`)
if (pinnedHex !== sha.toString('hex')) {
  console.error(`the wasm does not match contract/WASM_SHA256 (${pinnedHex}): build it with contract/build.sh --check`)
  process.exit(65)
}
console.log('matches contract/WASM_SHA256')

// ---- the launch values -------------------------------------------------------------------------

const params = readJson(join(ROOT, 'sim', 'params.json')).testnet
const cfg = { ...params.config }
for (const s of opts('--set')) {
  const m = /^([a-z_]+)=(.+)$/.exec(s ?? '')
  if (!m || !(m[1] in cfg) || m[1] === 'max_accounts') {
    console.error(`--set ${s}: expected <field>=<value> for a field of the testnet config other than max_accounts`)
    process.exit(64)
  }
  const [, field, value] = m
  if (typeof cfg[field] === 'number') {
    if (!/^\d+$/.test(value)) {
      console.error(`--set ${field}: a whole number`)
      process.exit(64)
    }
    cfg[field] = Number(value)
  } else if (/^\d+$/.test(params.config[field])) {
    if (!/^\d+$/.test(value)) {
      console.error(`--set ${field}: an amount in base units (digits only)`)
      process.exit(64)
    }
    cfg[field] = value
  } else {
    cfg[field] = value
  }
  console.log(`--set ${field} = ${value} (params.json: ${params.config[field]})`)
}
const labels = params.founders.map((f) => f.account_id.replace(/^REPLACE-WITH-ACCOUNT-ID:/, ''))

// ---- the demo bots: fresh keys, or the ones already made for this account ----------------------

let bots
if (existsSync(botsFile(account))) {
  bots = readJson(botsFile(account)).map((b) => Player.fromSecret(b.label, b.secret_key))
  console.log(`reusing the demo bot keys in .secrets/bots-${account}.json`)
} else if (deploy) {
  bots = labels.map((l) => Player.fresh(l))
  writeSecret(`bots-${account}.json`, bots.map((b) => ({ label: b.label, account_id: b.account, public_key: b.publicKey, secret_key: b.secretKey })))
  console.log(`wrote 5 new demo bot keys to .secrets/bots-${account}.json (mode 600)`)
} else {
  console.error(`no .secrets/bots-${account}.json: nothing to verify the founders against`)
  process.exit(65)
}
const founders = params.founders.map((f, i) => ({ account_id: bots[i].account, amount: f.amount }))
for (const [i, b] of bots.entries()) console.log(`  ${b.label.padEnd(17)} ${b.account}  ${ember(founders[i].amount)} EMBER`)
const genesis = BigInt(cfg.hearth_genesis) + founders.reduce((a, f) => a + BigInt(f.amount), 0n)

// ---- storage: the worst case must fit the balance ------------------------------------------------
// contract/README.md: code + 2,600 + 84 * founders + 211 * max_accounts + 472 * log_keep
//   + 2,257 * history_keep / 32 + 246 * (settled nights with uncollected throwers),
// plus what the account already stores (its own record and keys). The last term has no bound; we
// keep room for log_keep such nights.

const BYTE = 10n ** 19n
const signer = new Signer(account, keyFromKeychain(account))
if (deploy) {
  const acc = await viewAccount(account)
  const balance = BigInt(acc.amount)
  const accountBytes = BigInt(211 + 17 * Math.max(0, cfg.pool_windows - 4))
  const fixed =
    BigInt(code.length) + BigInt(acc.storage_usage) + 2_600n + 84n * BigInt(founders.length) +
    472n * BigInt(cfg.log_keep) + (2_257n * BigInt(cfg.history_keep)) / 32n + 246n * BigInt(cfg.log_keep)
  const budget = (balance - reserve) / BYTE
  const fit = budget > fixed ? (budget - fixed) / accountBytes : 0n
  const wanted = opt('--max-accounts') ? BigInt(opt('--max-accounts')) : BigInt(cfg.max_accounts)
  if (opt('--max-accounts') && wanted > fit) {
    console.error(`--max-accounts ${wanted} does not fit: at most ${fit} with ${near(balance)} NEAR`)
    process.exit(65)
  }
  const maxAccounts = wanted < fit ? wanted : fit
  if (maxAccounts < BigInt(founders.length)) {
    console.error(`the balance (${near(balance)} NEAR) cannot even hold the founders' storage`)
    process.exit(65)
  }
  cfg.max_accounts = Number(maxAccounts)
  const worst = fixed + accountBytes * maxAccounts
  console.log(`balance ${near(balance)} NEAR, reserve ${near(reserve)} NEAR: room for ${budget} bytes of storage, ${fit} accounts`)
  console.log(`fixed worst case ${fixed} bytes (code ${code.length}, account ${acc.storage_usage}, history ${(2_257n * BigInt(cfg.history_keep)) / 32n}, logs and uncollected nights ${718n * BigInt(cfg.log_keep)}, root ${2_600 + 84 * founders.length})`)
  console.log(`max_accounts ${cfg.max_accounts} (params.json: ${params.config.max_accounts}): worst case ${worst} bytes = ${near(worst * BYTE)} NEAR of stake`)
} else {
  if (!opt('--max-accounts')) {
    console.error('--verify-only and --lock-only need --max-accounts (the value the deployment used)')
    process.exit(64)
  }
  cfg.max_accounts = Number(opt('--max-accounts'))
}

// ---- deploy and init in one transaction ---------------------------------------------------------

if (deploy) {
  const before = await view(account, 'config').catch(() => null)
  if (before) {
    console.error(`${account} already runs a contract with a config; \`new\` can run only once`)
    process.exit(65)
  }
  const r = await signer.send(account, [
    deployContractAction(code),
    functionCallAction({ method: 'new', args: { config: cfg, founders }, gas: 100n * TGAS }),
  ])
  console.log(`deploy + new: tx ${r.hash}, ${tgas(r.gas)} Tgas burnt (receipt ${tgas(r.contractGas)} Tgas)${r.failure ? '  FAILED ' + r.failure : ''}`)
  if (r.failure) process.exit(1)
  for (let i = 0; i < 15; i++) {
    if ((await viewAccount(account, 'final')).code_hash === codeHash) break
    await sleep(1000)
  }
}

// ---- verify --------------------------------------------------------------------------------------

const problems = []
function check(what, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ': ' + detail : ''}`)
  if (!ok) problems.push(what)
}

const onChain = await viewAccount(account, 'final')
check('code hash on chain equals contract/WASM_SHA256', onChain.code_hash === pinnedHash && onChain.code_hash === codeHash, onChain.code_hash)

const shown = await view(account, 'config', {}, 'final')
const keysWanted = Object.keys(cfg).sort()
const keysShown = Object.keys(shown.config).sort()
check('config() has exactly the intended fields', JSON.stringify(keysShown) === JSON.stringify(keysWanted), keysShown.length + ' fields')
for (const k of keysWanted) check(`config().${k}`, String(shown.config[k]) === String(cfg[k]), `${shown.config[k]}${String(shown.config[k]) === String(cfg[k]) ? '' : ' (intended ' + cfg[k] + ')'}`)
check('config().founders are the five demo bots with their allocations', JSON.stringify(shown.founders) === JSON.stringify(founders))
check('config().genesis_supply', shown.genesis_supply === String(genesis), ember(shown.genesis_supply))

const [supply, hearthBalance, st, audit] = await Promise.all([
  view(account, 'ft_total_supply', {}, 'final'),
  view(account, 'ft_balance_of', { account_id: account }, 'final'),
  view(account, 'state', {}, 'final'),
  view(account, 'audit', {}, 'final'),
])
check('ft_total_supply = hearth_genesis + founders', supply === String(genesis), ember(supply))
check('hearth = hearth_genesis', st.hearth === String(cfg.hearth_genesis) && hearthBalance === String(cfg.hearth_genesis), ember(st.hearth))
for (const f of founders) {
  const label = bots.find((b) => b.account === f.account_id).label
  const [bal, h] = await Promise.all([
    view(account, 'ft_balance_of', { account_id: f.account_id }, 'final'),
    view(account, 'holder', { account_id: f.account_id }, 'final'),
  ])
  check(`${label} holds its allocation`, bal === f.amount && h.credited === f.amount && h.pending === '0' && h.registered && h.sponsored && h.held && !h.kindled, ember(bal))
}
check('audit() balanced and ledger', audit.balanced && audit.ledger)
check('audit(): supply = genesis, nothing minted, burned, owed or on the pile',
  audit.supply === String(genesis) && audit.genesis === String(genesis) && audit.minted === '0' && audit.burned === '0' && audit.owed === '0' && audit.pile === '0')
const zeroRecords = Object.values(st.records).every((v) => String(v) === '0')
check('state() at night 1, untouched',
  st.night === 1 && st.pile === '0' && st.throwers === 0 && st.firestarter === null && st.streak === 0 && zeroRecords && st.last === null &&
  st.target === String(cfg.target_start) && st.accounts_sponsored === founders.length && st.max_accounts === cfg.max_accounts &&
  st.kindling_left_tonight === cfg.kindling_per_night,
  `night ${st.night} (clock ${st.clock_night}), target ${ember(st.target)}, sponsored ${st.accounts_sponsored}/${st.max_accounts}, kindling left ${st.kindling_left_tonight}`)
const keys = await accessKeys(account, 'final')
const mine = nearPublicKey(signer.key)
check("only the deployer's full-access key exists", keys.length === 1 && keys[0].public_key === mine && keys[0].access_key.permission === 'FullAccess',
  keys.map((k) => `${k.public_key} ${typeof k.access_key.permission === 'string' ? k.access_key.permission : 'FunctionCall'}`).join(', '))
console.log(`storage ${audit.storage_bytes} bytes, stake ${near(audit.storage_stake)} NEAR, balance ${near(audit.near_balance)} NEAR`)

if (problems.length) {
  console.error(`${problems.length} checks failed${lock ? ': NOT locking' : ''}`)
  process.exit(1)
}
console.log(`all checks passed (max_accounts ${cfg.max_accounts})`)

// ---- lock: delete every access key ---------------------------------------------------------------

if (lock) {
  console.log(`--lock: deleting the ${keys.length} access key(s) of ${account}; this cannot be undone`)
  const d = await signer.send(account, keys.map((k) => deleteKeyAction(k.public_key)))
  console.log(`delete keys: tx ${d.hash}, ${tgas(d.gas)} Tgas${d.failure ? '  FAILED ' + d.failure : ''}`)
  if (d.failure) process.exit(1)
  let proof
  for (let i = 0; i < 20; i++) {
    proof = await rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: account })
    if (proof.keys.length === 0) break
    await sleep(1500)
  }
  console.log(`view_access_key_list(${account}, final): ${JSON.stringify(proof)}`)
  if (proof.keys.length !== 0) {
    console.error('WARNING: keys remain')
    process.exit(1)
  }
  console.log(`${account} has no access keys: nobody can change it`)
}
