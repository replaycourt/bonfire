// Everything that ties this page to one deployment, in one place.
//
// Bonfire players never see a wallet. Their browser makes an Ed25519 key, and every action is signed
// with that key and relayed through the contract's `act` method. Somebody has to pay the gas for the
// relaying transaction: on testnet that is GAS_ACCOUNT, through the public function-call keys below.
//
// Each of those keys may ONLY call `act` and `settle` on CONTRACT, with a capped allowance. It cannot
// move NEAR, cannot touch any other contract and cannot act for a player: `act` checks the player's
// own signature, so a key holder can only relay what a player already signed. The worst anyone can do
// with them is burn the allowance, which pauses free play until the pool is refilled.
//
// GAS_KEYS stays empty until the gas pool exists. While it is empty the page shows the fire (if the
// contract is deployed) but offers no actions.
//
// RPC_HOSTS must match `connect-src` in index.html (test/config.test.mjs checks that).

export const CONTRACT = 'bonfire-coin.testnet'
export const GAS_ACCOUNT = 'bonfire-gas.testnet'
export const NETWORK = 'testnet'

export const RPC_HOSTS = ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org']

export const EXPLORER = 'https://testnet.nearblocks.io'

/** Base58 sha256 of the deployed wasm, as `view_account` reports it; null until deployment. */
export const CODE_HASH = null

/** Gas attached to `act` and `settle` (the contract README advises 100 Tgas for both). */
export const ACT_GAS = 100_000_000_000_000n
export const SETTLE_GAS = 100_000_000_000_000n

/** Public function-call keys of GAS_ACCOUNT: { public_key, private_key } in NEAR string form. */
export const GAS_KEYS = []
