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
  },
  stage: {
    contract: 'bonfire-stage.testnet',
    gasAccount: 'bonfire-gas.testnet',
    codeHash: null,
    gasKeys: [],
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
