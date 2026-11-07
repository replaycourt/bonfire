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
    /** Base58 sha256 of the deployed wasm, as `view_account` reports it (contract/WASM_SHA256). */
    codeHash: 'EWcaLXmKxqtKqWGRE1NAnZQTq7i2q87JVUkhYi39mg5z',
    /** The transaction that deleted the contract's last access key, 16 s into night 1 (docs/testnet-launch.md). */
    lockTx: '8aK7rAMFFu6VkA1VbsVRvFjWRS6BP6gT9fWDBAxFT9KF',
    // PUBLIC on purpose: function-call keys of bonfire-gas.testnet that may only call `act`, `settle`
    // and `collect` on bonfire-coin.testnet, 0.5 NEAR allowance each for the first eight and 2 NEAR for
    // the eight added on 2026-11-07 (see the comment at the top).
    gasKeys: [
      { public_key: 'ed25519:7gRDwLNzBtmVw7Z2jMdEMAumEqemvwszy5u2jg1uoAsW', private_key: 'ed25519:2k5FVjkbrDJsDAVW8T4rRLrCkEroeYdeRPgjiuqcH9tua7VNuJ9hmisFj3ErrrXA4YxsFYKiszRpmZ2HGpguzwj2' },
      { public_key: 'ed25519:2FKVMYpKaCKkyDSrhSu5JW4pH86uNXcJNSYaajwwWiDn', private_key: 'ed25519:2s45nZwsVtgKkDuEypsMuht6G2rSQfxR2zU38C5DbLo7RgKCZ6DTMGHKK2jmC7eGLNzptGT19vCCz75D7wJVRRdi' },
      { public_key: 'ed25519:BjRCyknPQ9TWS8D4qBvASWEwJe5KW9kZ1Z2usy5NW1ps', private_key: 'ed25519:4BBpKeGaNP5zqt3htZwBZE3wTdX4nSvk1Zeyj6w7YQvYqe7pX79fDAS3vhdkZq7XRwBYSiFgfHHquXvDAzyTfMEX' },
      { public_key: 'ed25519:Gvf4wFcKksy3EvNyvu4smqi5g7ix3o3bhmPdLN1yQEcn', private_key: 'ed25519:3XVFERBXgjyNxTvEoA1qcMFbxReRs6H79tqMeCkNahN6ES881AU7rkcd7ebDvMN6EqvCki4TkmsJApbwZYzLfye6' },
      { public_key: 'ed25519:Ek2thQ9yQaf2vzosa9S1pftBpRBEJUqTVVevHXF2d6Ak', private_key: 'ed25519:3NGF8wDZ8RSd4wmsHvcBSUgaere9sG1kkcNUTKpqxHKnpnKubvXcXnwdESwNcZ8jQh2jMp4ceHdeu9fYgYLtu6pG' },
      { public_key: 'ed25519:C5XwcmSsLMai5KVKWq179fT4pzgw63RMj5mjuZvfTLda', private_key: 'ed25519:65ZJ2EaFYEyAtM2BgCXvRY9nriTeBp5HfRVpPoDyFXd4gjpuzXo59y7fi4Z2CB1Q4maSrVvRFfL7zLMXdCMJ284' },
      { public_key: 'ed25519:4pkBHwv3X5vpewnNoNAks5CUxQi6Ri5JVtoL62Xx9Rqd', private_key: 'ed25519:5ixEcYp35LVZFBEB9tnApEUsCgFi64Fr5wvthYBsEARQtSVLeLvccbmYNiTWSHqaPscqWkA5ttQVErBmvfJTFasm' },
      { public_key: 'ed25519:9fYhnTKiRuzwGrWrLPkVTEdBRVkWzwzUqs6dWhuZU3K8', private_key: 'ed25519:49jMt39Vg9zsLqbEHyYkJEBW7MsuJnPeYMpWQHkX9MNigT6z3ZgqpbsB7rsttNSekBLrFNpB6j6JjMBHp7iqpQz' },
      { public_key: 'ed25519:97nXfySaW4kfxpGfXCL6RKTMG9gQuycY5ZwwJg1HACaE', private_key: 'ed25519:37MSKsakYPziDvERU4TxCYPGg8xoejywV8sy4ckrjT7iLY7FyWDGzrXqQWbHAXagS3Nk5JcTsqorJFTwkM1KvCwC' },
      { public_key: 'ed25519:6UHJWjm9VPWKc37ARquyNabaMuc17xGo93oVPvbgX7fj', private_key: 'ed25519:5qDes4Ln1mGrNkDaydNjdPBGQrkyqSSC8wUUSSHpaiv7sCFRtvqEK1WXpNTcFc4fCoYpifkwhPsSHJkZhaC9s79f' },
      { public_key: 'ed25519:2qk4BFoLrhG9xgHG5WT8U1ysNMAsn5RuwKpWmgM59Kdq', private_key: 'ed25519:35da3aXB4xVXBVLw2VAU2ss37npLPtr1V4TC3EgASEMiKLMg7N9QrcCk2iishBTy1w7RqjEPKkwaPH3nCXBgACTR' },
      { public_key: 'ed25519:F4nkgmJNYbMgG2ZzJQsucZXNGx8MELhHt481yb3rpEiL', private_key: 'ed25519:TvjmMZWjJY9KVgeYEH6aCZQKqdV5UqmhAkRJ4EkoVd6ZwH8i8FQVZ9K5M6qKUq3aUiMezY1VTvXbaFXxobzdQMe' },
      { public_key: 'ed25519:9KnXmNNKb2oR95cjVrjFFWG7uSsLqP1JwZAWKGFfHQPo', private_key: 'ed25519:xLKfEYiH6dxe1jc7XjV9p5PEcLtWC5Km7BzGwHqnRxTEZ9g71xapRp4tYaSZMQVSApsDGe7ujN8hVDMNxWDmGCm' },
      { public_key: 'ed25519:GtoMz4uC4ULEFXrBt2maPX9zd69oiLQE6rFR6Nvtiy2K', private_key: 'ed25519:5eXEXkiNgvQSM5gEY1JUYv6fJFEsPSwaJpm9jNeMBL6EynHKqsgPRmrTS8pjS7Ty5Q9urpiJeMetFA8GyrHHeyD5' },
      { public_key: 'ed25519:CE7wuv4JCmBFixjtcbM5tBCPeRzJJokfK6JwX5EWXtcU', private_key: 'ed25519:4dq4hY6jXBpNXAYdcfQ42rfTShKx6Voi4jgsiz7uoWijzeYqtksdhVnwiXSfcBhrzxQiMqbsYw7cUDEZNaVDXH4x' },
      { public_key: 'ed25519:yuGzdvSTEtbt9MpzzjNpGcz4sqQ2tJcvUo1sie6L53v', private_key: 'ed25519:3GjPzZJtjCXp7Y85VaUJ7cpngGqtBtPSLiHfyPwkwv8zVaNWtEiCf3K4BLJqfwDzHi8P8kFcAVTgEzKXBwLhXDf6' },
    ],
    /** The demo bots (the founders of the testnet demo), so the page labels them as bots. */
    bots: {
      '7cbadc6deccc1de5ede5fec0209501eeda19bd6c7f33ef9c38b07b8989c06cc6': 'demo-bot-early-a',
      '8b6685478ca7e0288b2c500e6c147470adb264644f6586a7ca546a386870b8dc': 'demo-bot-early-b',
      '89b07f92e0021cb002cd0e50ee4b2478c88ec2bab8f8b9b941c9e2a89d8072ca': 'demo-bot-steady',
      '9cd9d63db11f5cad14905981d7b8c58d9f80826cfc85e5b6340251aab68e7d55': 'demo-bot-late',
      '9527561a2b84b767ea694b63bb702c229e4d14ee3fa6ca67cce7bd46c7021a91': 'demo-bot-idle',
    },
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
