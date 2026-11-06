#!/usr/bin/env node
// Deploys the Bonfire wasm to a testnet account and calls `new` in the same transaction, with the
// testnet launch values of sim/params.json and five demo bots as founders.
//
//   node scripts/deploy.mjs <account> [--wasm <path>] [--max-accounts <n>] [--reserve <NEAR>] [--lock]
//
// - The wasm defaults to contract/target/near/bonfire.wasm (what contract/build.sh prints).
// - The account signs with its full-access key from the legacy keychain (~/.near-credentials/testnet).
// - max_accounts: the testnet value of sim/params.json, lowered so the worst-case storage stake
//   (contract/README.md, "Storage") fits the account's balance minus --reserve (default 0.1 NEAR).
//   --max-accounts sets it explicitly; it is still refused if the stake would not fit.
// - Founders: five demo bot implicit accounts. Their ed25519 keys are generated here and saved to
//   the git-ignored .secrets/bots-<account>.json (mode 600); the hearth genesis is in the config.
// - --lock deletes every access key of the account afterwards, so nobody can ever change the
//   contract. It cannot be undone. Never on staging.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  Signer, accessKeys, assertTestnet, b58encode, deleteKeyAction, deployContractAction, functionCallAction,
  keyFromKeychain, near, tgas, view, viewAccount,
} from './near-lite.mjs'
import { Player, ROOT, TGAS, botsFile, ember, readJson, sleep, writeSecret } from './bonfire-lib.mjs'

const argv = process.argv.slice(2)
const opt = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const account = argv[0]
if (!account || account.startsWith('--')) {
  console.error('usage: deploy.mjs <account> [--wasm <path>] [--max-accounts <n>] [--reserve <NEAR>] [--lock]')
  process.exit(64)
}
assertTestnet(account)
const lock = argv.includes('--lock')
const wasmPath = opt('--wasm') ?? join(ROOT, 'contract', 'target', 'near', 'bonfire.wasm')
const reserve = BigInt(Math.round(Number(opt('--reserve') ?? '0.1') * 1e6)) * 10n ** 18n

const code = readFileSync(wasmPath)
const sha = createHash('sha256').update(code).digest()
const codeHash = b58encode(sha)
console.log(`wasm ${wasmPath.replace(ROOT + '/', '')}: ${code.length} bytes, sha256 ${sha.toString('hex')}, code hash ${codeHash}`)
const pinned = existsSync(join(ROOT, 'contract', 'WASM_SHA256')) ? readFileSync(join(ROOT, 'contract', 'WASM_SHA256'), 'utf8').trim() : null
console.log(pinned === sha.toString('hex') ? 'matches contract/WASM_SHA256' : `NOTE: contract/WASM_SHA256 says ${pinned}`)

// ---- the launch values -------------------------------------------------------------------------

const params = readJson(join(ROOT, 'sim', 'params.json')).testnet
const cfg = { ...params.config }
const labels = params.founders.map((f) => f.account_id.replace(/^REPLACE-WITH-ACCOUNT-ID:/, ''))

// ---- the demo bots: fresh keys, or the ones already made for this account ----------------------

let bots
if (existsSync(botsFile(account))) {
  bots = readJson(botsFile(account)).map((b) => Player.fromSecret(b.label, b.secret_key))
  console.log(`reusing the demo bot keys in .secrets/bots-${account}.json`)
} else {
  bots = labels.map((l) => Player.fresh(l))
  writeSecret(`bots-${account}.json`, bots.map((b) => ({ label: b.label, account_id: b.account, public_key: b.publicKey, secret_key: b.secretKey })))
  console.log(`wrote 5 demo bot keys to .secrets/bots-${account}.json (mode 600)`)
}
const founders = params.founders.map((f, i) => ({ account_id: bots[i].account, amount: f.amount }))
for (const [i, b] of bots.entries()) console.log(`  ${b.label.padEnd(17)} ${b.account}  ${ember(founders[i].amount)} EMBER`)

// ---- storage: the worst case must fit the balance ------------------------------------------------
// contract/README.md: code + 2,600 + 84 * founders + 211 * max_accounts + 472 * log_keep
//   + 2,257 * history_keep / 32 + 246 * (settled nights with uncollected throwers),
// plus what the account already stores (its own record and keys). The last term has no bound; we
// keep room for log_keep such nights.
const BYTE = 10n ** 19n
const acc = await viewAccount(account)
const balance = BigInt(acc.amount)
const accountBytes = BigInt(211 + 17 * Math.max(0, cfg.pool_windows - 4))
const fixed =
  BigInt(code.length) + BigInt(acc.storage_usage) + 2_600n + 84n * BigInt(founders.length) +
  472n * BigInt(cfg.log_keep) + (2_257n * BigInt(cfg.history_keep)) / 32n + 246n * BigInt(cfg.log_keep)
const budget = (balance - reserve) / BYTE
const fit = budget > fixed ? (budget - fixed) / accountBytes : 0n
const wanted = opt('--max-accounts') ? BigInt(opt('--max-accounts')) : BigInt(cfg.max_accounts)
const maxAccounts = wanted < fit ? wanted : fit
if (opt('--max-accounts') && wanted > fit) {
  console.error(`--max-accounts ${wanted} does not fit: at most ${fit} with ${near(balance)} NEAR`)
  process.exit(65)
}
if (maxAccounts < BigInt(founders.length)) {
  console.error(`the balance (${near(balance)} NEAR) cannot even hold the founders' storage`)
  process.exit(65)
}
cfg.max_accounts = Number(maxAccounts)
const worst = fixed + accountBytes * maxAccounts
console.log(`balance ${near(balance)} NEAR, reserve ${near(reserve)} NEAR: room for ${budget} bytes of storage`)
console.log(`fixed worst case ${fixed} bytes (code ${code.length}, account ${acc.storage_usage}, history ${(2_257n * BigInt(cfg.history_keep)) / 32n}, logs and uncollected nights ${718n * BigInt(cfg.log_keep)}, root ${2_600 + 84 * founders.length})`)
console.log(`max_accounts ${cfg.max_accounts} (params.json: ${params.config.max_accounts}): worst case ${worst} bytes = ${near(worst * BYTE)} NEAR of stake`)

// ---- deploy and init in one transaction ---------------------------------------------------------

const signer = new Signer(account, keyFromKeychain(account))
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

// ---- check what is on chain ----------------------------------------------------------------------

let onChain
for (let i = 0; i < 10; i++) {
  onChain = await viewAccount(account, 'optimistic')
  if (onChain.code_hash === codeHash) break
  await sleep(1000)
}
const shown = await view(account, 'config')
const canon = (o) => JSON.stringify(o, Object.keys(o).sort())
const same = canon(shown.config) === canon(cfg) && JSON.stringify(shown.founders) === JSON.stringify(founders)
const audit = await view(account, 'audit')
const supply = await view(account, 'ft_total_supply')
console.log(`code_hash ${onChain.code_hash} ${onChain.code_hash === codeHash ? 'matches the wasm' : 'DIFFERS'}`)
console.log(`config() ${same ? 'equals the init arguments' : 'DIFFERS from the init arguments'}; account record ${shown.account_storage_bytes} bytes (assumed ${accountBytes})`)
console.log(`supply ${ember(supply)} EMBER, hearth ${ember(audit.hearth)}, balanced ${audit.balanced}, ledger ${audit.ledger}`)
console.log(`storage ${audit.storage_bytes} bytes, stake ${near(audit.storage_stake)} NEAR, balance ${near(audit.near_balance)} NEAR`)
if (!same || onChain.code_hash !== codeHash || !audit.balanced || !audit.ledger) process.exit(1)
if (BigInt(shown.account_storage_bytes) > accountBytes) console.log('WARNING: account records are larger than the storage budget assumed')

// ---- lock: delete every access key ---------------------------------------------------------------

if (lock) {
  const keys = await accessKeys(account, 'optimistic')
  console.log(`--lock: deleting ${keys.length} access keys of ${account}`)
  const d = await signer.send(account, keys.map((k) => deleteKeyAction(k.public_key)))
  console.log(`delete keys: tx ${d.hash}${d.failure ? '  FAILED ' + d.failure : ''}`)
  await sleep(3000)
  const left = await accessKeys(account, 'final')
  console.log(left.length === 0 ? `${account} has no access keys: nobody can change it` : `WARNING: ${left.length} keys remain`)
} else {
  console.log(`keys kept (no --lock): ${(await accessKeys(account, 'optimistic')).length}`)
}
console.log(JSON.stringify({ account, tx: r.hash, code_hash: codeHash, max_accounts: cfg.max_accounts, genesis_ms: shown.genesis_ms }))
