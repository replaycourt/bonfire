#!/usr/bin/env node
// Adds a pool of function-call keys to the gas account, limited to `act`, `settle` and `collect`
// on one contract and capped by an allowance each, in one transaction signed with the gas
// account's full-access key from the legacy keychain. The keys go to the git-ignored
// .secrets/gas-pool-<contract>.json (mode 600); the page and the bots relay through them.
//
//   node scripts/setup-gas-pool.mjs <gas account> <contract> <how many> [allowance in NEAR, default 0.5]
//
// The contract need not exist yet: a function-call key only names its receiver.
import { existsSync } from 'node:fs'
import { Signer, accessKeys, addFunctionCallKeyAction, assertTestnet, keyFromKeychain, nearPublicKey, nearSecretKey, newKey, tgas } from './near-lite.mjs'
import { poolFile, readJson, writeSecret } from './bonfire-lib.mjs'

const METHODS = ['act', 'settle', 'collect']
const [gasAccount, contract, count, allowance = '0.5'] = process.argv.slice(2)
if (!gasAccount || !contract || !count || !(Number(count) > 0 && Number(count) <= 32)) {
  console.error('usage: setup-gas-pool.mjs <gas account> <contract> <how many, 1-32> [allowance in NEAR]')
  process.exit(64)
}
assertTestnet(gasAccount, contract)
const yocto = BigInt(Math.round(Number(allowance) * 1e6)) * 10n ** 18n
if (yocto <= 0n || yocto > 5n * 10n ** 24n) {
  console.error('allowance: more than 0 and at most 5 NEAR per key')
  process.exit(64)
}

const file = poolFile(contract)
const pool = existsSync(file) ? readJson(file) : []
const fresh = Array.from({ length: Number(count) }, () => newKey())
const actions = fresh.map((k) => addFunctionCallKeyAction({ publicKey: nearPublicKey(k), receiverId: contract, methods: METHODS, allowance: yocto }))

const owner = new Signer(gasAccount, keyFromKeychain(gasAccount))
const r = await owner.send(gasAccount, actions)
if (r.failure) {
  console.error(`add keys failed: ${r.failure} (${r.hash})`)
  process.exit(1)
}
for (const k of fresh) {
  pool.push({
    account: gasAccount,
    contract,
    methods: METHODS,
    allowance_near: allowance,
    public_key: nearPublicKey(k),
    private_key: nearSecretKey(k),
  })
}
const written = writeSecret(`gas-pool-${contract}.json`, pool)
console.log(`added ${fresh.length} function-call keys to ${gasAccount} for ${contract} (${METHODS.join(', ')}; ${allowance} NEAR each)`)
console.log(`tx ${r.hash}  ${tgas(r.gas)} Tgas`)
const onChain = await accessKeys(gasAccount, 'optimistic')
const mine = onChain.filter((k) => k.access_key.permission.FunctionCall?.receiver_id === contract)
console.log(`${mine.length} function-call keys for ${contract} on chain; secrets in ${written.replace(/.*\/\.secrets\//, '.secrets/')}`)
