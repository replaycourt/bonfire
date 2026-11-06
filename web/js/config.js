// Everything that ties this page to one deployment, in one place.
//
// Bonfire players never see a wallet. Their browser makes an Ed25519 key, and every action is signed
// with that key and relayed through the contract's `act` method. Somebody has to pay the gas for the
// relaying transaction: on testnet that is the deployment's gas account, through public
// function-call keys.
//
// Each of those keys may ONLY call `act`, `settle` and `collect` on its contract, with a capped
// allowance. It cannot move NEAR, cannot touch any other contract and cannot act for a player: `act`
// checks the player's own signature, so a key holder can only relay what a player already signed,
// and `settle` and `collect` only do what anyone may do. The worst anyone can do with them is burn
// the allowance, which pauses free play until the pool is refilled.
//
// A deployment's `gasKeys` stays empty until its pool exists. While it is empty the page shows the
// fire (if the contract answers) but offers no actions.
//
// Which deployment the page uses: DEFAULT below, or `?contract=stage` / `?contract=final` in the URL
// (only these names; nothing else is accepted). RPC_HOSTS must match `connect-src` in index.html
// (test/config.test.mjs checks that).

export const DEPLOYMENTS = {
  final: {
    contract: 'bonfire-coin.testnet',
    gasAccount: 'bonfire-gas.testnet',
    /** Base58 sha256 of the deployed wasm, as `view_account` reports it; null until deployment. */
    codeHash: null,
    /** Public function-call keys of gasAccount: { public_key, private_key } in NEAR string form. */
    gasKeys: [],
    /** The demo bots (the founders of the testnet demo), so the page labels them as bots; filled in at deployment. */
    bots: {},
  },
  stage: {
    contract: 'bonfire-stage.testnet',
    gasAccount: 'bonfire-gas.testnet',
    codeHash: 'EWcaLXmKxqtKqWGRE1NAnZQTq7i2q87JVUkhYi39mg5z',
    // PUBLIC on purpose: function-call keys of bonfire-gas.testnet that may only call `act`, `settle`
    // and `collect` on bonfire-stage.testnet, 0.5 NEAR allowance each (see the comment at the top).
    gasKeys: [
      { public_key: 'ed25519:BSW69MsiDXxC2gHsnzYbcgYvhr7j5qtLZpfPL2cysech', private_key: 'ed25519:42Dvk2hzxACST3hYeZtExRU5pFNLBv1ZesjWphnRzKrf8TNJawvKYDp6TTz84gbRQstt2djv77DjmLqSSuimhbry' },
      { public_key: 'ed25519:2Nqzw3Q1xYQRrv8TnkHGCjawvAAGRrjEVrsndL9mCHyd', private_key: 'ed25519:WU1AjrLjKUynTgbH4mpGyKyGnoUQtAx2i9raxMTD4BSdjaC4QqRv7dg8utaxmJhnhKBptsYidkAJd4PNwodTuko' },
      { public_key: 'ed25519:AooMYPm1NSh6FCheKVP8Cj9rmtZCL5gEHMnDsK6MmPPc', private_key: 'ed25519:4umv5sae5gsVcGzKZES6ZfZYc5C4z3sjWAHiMNbQ8ytgsTkDVYthmwtNJo73tFNZyw1SbdNqCMYHL3uxnJMeQgBG' },
      { public_key: 'ed25519:Ho1Lk8N6CcJxe4umes7Wc4BcwXSmt1UCwz8WeZTQaagL', private_key: 'ed25519:38MAhAsLRQLqYfyMZdBq4b6Ko3viX1fCEwmUps8kVmyPg9uUgzQryVxsLySaYrfhHwcvCPXLgmUcbGeCsaKNwL9i' },
      { public_key: 'ed25519:GSvKnPFTsnk9i3NttPpuSF9haMy8NPRS4rqsPjMQNPyD', private_key: 'ed25519:3AgemDLiay53BuLxGBTehUjXV1A6k7GHNv3rkt6PXtkjV1LJaE8i5YkQD7Axtpz8fFuYQMWjbddoKaaU8xcbbtfu' },
      { public_key: 'ed25519:89Aw9UZ7Et1AUw1YfKWsuinUm4dxGNmFDzueswtjjvYL', private_key: 'ed25519:3LMHysmY6MENNFFRvgcKCH73RuKnKeskVye59LLZXYDmqREEPECvphoodxayGeUGYKyhLVNCcA1S41VZhizF28rY' },
      { public_key: 'ed25519:4PWNB7DgRgnmrgbD1azAkiLMkB28DHj4yTN64TbnizkB', private_key: 'ed25519:39oYJ1nUbanh6KjCZsbRc3P9wAnafoayaFJdfYsqw1qQ1y91me7FAUVgw965QMwWcAQfXcvdT463yCwSXHKnS4yq' },
      { public_key: 'ed25519:6WeDLoL2vFhN57wfHLnrNj7gQqQGZK6iPReot7j2pi98', private_key: 'ed25519:62QFrhVzMM3BvdsXEVjQS5KJKg7jyNGo4agjstQGkPjo9Taq7TUsSj5s26YNUrfhzuTqdAqox29dgEy6XZ4t7Kb8' },
    ],
    bots: {
      fa95c058173f568ff31a0b70639f341a0562cfb75c9e025c6ddc7c798b19c09d: 'demo-bot-early-a',
      f057a749bdd5422725afaebd4f2d6ca51936e2425e9f18c37c3c33eb6e2f6bb0: 'demo-bot-early-b',
      f182fb24affed23d61c14d0dfb0def6f04c66487413cfde9eb0b4df7baca3fa1: 'demo-bot-steady',
      '6abd39e87f9041f82994ede0eccdb24ee8d5c7c0146f8227efca6cc63113b7d1': 'demo-bot-late',
      d677697d73001c2e3bc2dd58ef6b626be0d48fa32e4fa4d80b84d2f6a6204a11: 'demo-bot-idle',
    },
  },
}

export const DEFAULT = 'final'

export const NETWORK = 'testnet'
export const RPC_HOSTS = ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org']
export const EXPLORER = 'https://testnet.nearblocks.io'

/** Gas attached to `act`, `settle` and `collect` (the contract README advises 30 Tgas). */
export const ACT_GAS = 30_000_000_000_000n
export const SETTLE_GAS = 30_000_000_000_000n
export const COLLECT_GAS = 30_000_000_000_000n

/** Collections the page relays for other throwers per visit, to free settled nights' records. */
export const HELP_COLLECTS_PER_VISIT = 4

/** The deployment named by `?contract=` if it is one of DEPLOYMENTS, else DEFAULT. */
export function pickDeployment(search = globalThis.location?.search ?? '') {
  const name = new URLSearchParams(search).get('contract')
  const key = name && Object.hasOwn(DEPLOYMENTS, name) ? name : DEFAULT
  return { name: key, ...DEPLOYMENTS[key] }
}

export const DEPLOYMENT = pickDeployment()
export const CONTRACT = DEPLOYMENT.contract
export const GAS_ACCOUNT = DEPLOYMENT.gasAccount
export const GAS_KEYS = DEPLOYMENT.gasKeys
export const CODE_HASH = DEPLOYMENT.codeHash
export const BOTS = DEPLOYMENT.bots
