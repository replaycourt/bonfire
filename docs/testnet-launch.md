# Bonfire on testnet: the keyless launch

The final contract is `bonfire-coin.testnet`. It runs the committed wasm with the testnet launch values (two of them changed, below), and every access key of the account was deleted right after the deployment, so nobody can change, upgrade or drain it. Staging ([`testnet-stage.md`](testnet-stage.md), [`testnet-page-run.md`](testnet-page-run.md)) found no contract bug first.

| | |
|---|---|
| Contract | `bonfire-coin.testnet` |
| Code hash | `EWcaLXmKxqtKqWGRE1NAnZQTq7i2q87JVUkhYi39mg5z` (base58 of `contract/WASM_SHA256` c8bdff7e…7bfd) |
| Night 1 began | 2026-11-06 09:50:27.743 UTC (`genesis_ms` 1793958627743) |
| Access keys | none: `view_access_key_list` returns `"keys":[]` |
| Relay | `bonfire-gas.testnet`, 16 function-call keys for `act`, `settle`, `collect` (8 at launch, 8 more on 2026-11-07) |

## The launch values

The `testnet` block of `sim/params.json`, with two changes:

- **`kindling_per_night` 4** (was 1), so a second visitor on the same night need not wait a whole night for kindling;
- **`hearth_genesis` 3,000,000 EMBER** (was 900,000), so that a script winning every kindling claim still cannot empty the hearth before 2026-11-19.

**The drain, re-checked** with the simulation's own formula (`md_drain` in `sim/bonfire_sim.py`), the refill from lit nights counted as zero: at most 200 EMBER x 4 claims a night x 12 nights an hour = 9,600 EMBER an hour, so emptying 3,000,000 EMBER takes at least 312.5 hours (13.0 days). From night 1 that is 2026-11-19 10:20 UTC at the earliest. Smoky nights burn a little more from the hearth, at most one night's mint (4 % of the target) each: even if every night smoked at a target of 600 EMBER, the hearth would last 303 hours. Both are above 300 hours, so `hearth_genesis` stays at 3,000,000.

**`max_accounts` 4,505**, the value of `sim/params.json`: the five bots and 4,500 sponsored kindling claims. Its worst-case storage (`contract/README.md`, "Storage", with room for 48 settled nights nobody collects) is 1,566,397 bytes, 15.66 NEAR of stake, and the account holds 22.64 NEAR. Room would allow up to 7,763 accounts; we kept the design value and leave the rest as headroom for uncollected nights. A limit to know: at 4 claims a night, a script that wins every claim fills the 4,500 sponsored places in 1,125 nights, about 94 hours. After that a newcomer without a NEAR wallet cannot register, because only `storage_deposit` registers it. The hearth itself would last longer.

| Field | Value | |
|---|---|---|
| `name`, `symbol`, `decimals` | Bonfire, EMBER, 18 | |
| `night_ms` | 300,000 | five minutes |
| `hearth_genesis` | 3,000,000 EMBER | changed |
| founders | 40,000 / 30,000 / 15,000 / 5,000 / 10,000 EMBER | the five demo bots |
| genesis supply | 3,100,000 EMBER | |
| `target_start`, `target_min` | 400, 100 EMBER | |
| `grow_bp`, `shrink_bp` | 700, 1,000 | +7 % lit, -10 % smoked or cold |
| `mint_bp`, `hearth_cut_bp` | 400, 1,000 | 4 % of the target, 10 % of it to the hearth |
| `smoke_bp`, `hearth_burn_bp` | 300, 25 | 3 % of the pile; 0.25 % of the hearth, at most one night's mint |
| `early_max_bp`, `late_lit_bp` | 40,000, 2,500 | |
| `pool_windows` | 4 | 75-second windows |
| `target_cap_bp` | 2,500 | 25 % of the free supply |
| `min_throw` | 1 EMBER | |
| `kindling`, `kindling_per_night` | 200 EMBER, 4 | changed: 4 |
| `max_catchup`, `log_keep`, `history_keep` | 30, 48, 4,096 | |
| `max_accounts` | 4,505 | |

## Accounts and funding

| Account | What happened | Transaction |
|---|---|---|
| `bonfire-coin.testnet` | created through the testnet faucet with the NEAR CLI (`sponsor-by-faucet-service`), 10 NEAR | `5T5UMqE4PBZ9DvisZLSLfNCtVRRL2w3otEXT5VrrZLLo` |
| `lantern-row-stress2.testnet` | sent 6.32 NEAR to `bonfire-coin.testnet` | `4tujepv31DwSZ63juYC9Nuvs6ZbpWoryg3nm1dSjSNDc` |
| `lantern-row-stress3.testnet` | sent 6.32 NEAR to `bonfire-coin.testnet` | `84wziPqP1V7hv3qkCwLYqR1LQiRqQYs6HC3Ya6FFRo8s` |
| `bonfire-gas.testnet` | 8 function-call keys for `bonfire-coin.testnet` (`act`, `settle`, `collect`, 0.5 NEAR allowance each), one transaction | `Fudx76KhN2BKVTmdw9EfDSe3UrgfbFeLpbpSNxmrWfkn` |
| `bonfire-gas.testnet` | 2026-11-07: 8 more function-call keys, same methods, 2 NEAR allowance each, so the relay lasts through judging (the first eight had 3.6 NEAR left at about 0.4 NEAR a day) | `5rUR76kDS91yA9mubUfFwoFErJKcK7bvgxGwPY6bQnqj` |

`bonfire-coin.testnet` then held 22.64 NEAR. The two Lantern Row accounts each keep their contract's storage stake (about 3.59 NEAR) plus 0.06 NEAR; they had nothing more to give, so the 25-28 NEAR first aimed at was not reachable from them. `lantern-row-stress.testnet` was not touched (9.99 NEAR). `bonfire-gas.testnet` held 9.96 NEAR, above 8, so it needed no top-up.

## Deployment, checks and lock

`scripts/deploy.mjs bonfire-coin.testnet --set kindling_per_night=4 --set hearth_genesis=3000000000000000000000000 --lock` made five new demo bot keys (git-ignored `.secrets/bots-bonfire-coin.testnet.json`, mode 600), deployed and initialised in one transaction, checked the result, and deleted the access key only after every check had passed.

- Deploy and `new`: `HTxpoV7QMguT9MFRSqzxp7mqGoUCvyyFTH5E2rVKVzTx` (24.71 Tgas).
- Checks, all passed, read at `final` finality:
  - the code hash on chain equals `contract/WASM_SHA256` and the deployed file;
  - `config()` has exactly the 24 intended fields, each equal to the intended value; the founders are the five bots with their allocations; the genesis supply is 3,100,000;
  - `ft_total_supply` 3,100,000; the hearth (`state().hearth` and `ft_balance_of(contract)`) 3,000,000; each bot holds its allocation, registered, sponsored, nothing pending;
  - `audit()`: balanced and ledger true, supply = genesis, nothing minted, burned, owed or on the pile;
  - `state()`: night 1, untouched, target 400, 5 of 4,505 accounts sponsored, 4 kindling claims left tonight;
  - the only access key was the deployer's full-access key `ed25519:J2Koyf5b2DY1nXfMHQ4PAKSQCSiWbwULArqrXGNWPE28`.
- Lock: `8aK7rAMFFu6VkA1VbsVRvFjWRS6BP6gT9fWDBAxFT9KF` deleted that key. Then:

```
view_access_key_list(bonfire-coin.testnet, final):
{"block_hash":"21yW2TDHznRKy3ymbQmhufHEMuQHEp8FsoXDZPW2PXJS","block_height":276471545,"keys":[]}
```

Anyone can repeat the check:

```
curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"bonfire-coin.testnet"}}'
```

## The demo bots

| Bot | Account | Founding EMBER |
|---|---|---|
| demo-bot-early-a | `7cbadc6deccc1de5ede5fec0209501eeda19bd6c7f33ef9c38b07b8989c06cc6` | 40,000 |
| demo-bot-early-b | `8b6685478ca7e0288b2c500e6c147470adb264644f6586a7ca546a386870b8dc` | 30,000 |
| demo-bot-steady | `89b07f92e0021cb002cd0e50ee4b2478c88ec2bab8f8b9b941c9e2a89d8072ca` | 15,000 |
| demo-bot-late | `9cd9d63db11f5cad14905981d7b8c58d9f80826cfc85e5b6340251aab68e7d55` | 5,000 |
| demo-bot-idle | `9527561a2b84b767ea694b63bb702c229e4d14ee3fa6ca67cce7bd46c7021a91` | 10,000 |

`web/js/config.js` labels them on the page (`DEPLOYMENTS.final.bots`), next to the eight public gas keys and the code hash. The final deployment is the page's default.

**Keeping the fire alive.** `.github/workflows/fire.yml` runs `scripts/bots.mjs bonfire-coin.testnet --minutes 350` every six hours (and on demand), with the bot seeds only from the repository secret `BONFIRE_BOTS`: a JSON array of the five hex seeds, each checked against the labels in `web/js/config.js`. The value is in the git-ignored `.secrets/github-secret-BONFIRE_BOTS.txt` (mode 600). Without the secret the job logs "no bot keys, nothing to do" and succeeds. The bots share the gas keys with the page: every transaction reads its key's nonce afresh, takes a random key, and on `InvalidNonce` reads the nonce again and retries once, then tries another key (`scripts/test/relay.test.mjs`). Their `act` nonces are time-based, so they keep rising across runs and machines.

## Seeding the fire

Right after the lock the five bots played seven nights locally (`scripts/bots.mjs bonfire-coin.testnet --nights 7 --always --smoke 5`, kept awake with `caffeinate -is`, 2026-11-06 09:50 to 10:25 UTC), so the page starts with a history, a streak and a smoky night. On the fifth night they under-threw on purpose: the early bots threw a quarter of their usual wood and the steady and late bots held back. `audit()` was checked after every settle (7 times), balanced and ledger true each time. 53 transactions, none failed, and after the last night every bot had collected (nothing owed).

| Night | Outcome | Target | Pile | Throwers | Minted | Burned | Next target | Streak | Firestarter | Last log |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | LIT | 400.00 | 615.60 | 4 | 16.00 | 0.00 | 428.00 | 1 | demo-bot-early-b | demo-bot-steady (184.02) |
| 2 | LIT | 428.00 | 597.48 | 4 | 17.12 | 0.00 | 457.96 | 2 | demo-bot-early-a | demo-bot-steady (171.45) |
| 3 | LIT | 457.96 | 593.46 | 4 | 18.31 | 0.00 | 490.01 | 3 | demo-bot-early-a | demo-bot-steady (161.44) |
| 4 | LIT | 490.01 | 597.83 | 4 | 19.60 | 0.00 | 524.31 | 4 | demo-bot-early-b | demo-bot-steady (115.06) |
| 5 | SMOKED | 524.31 | 81.45 | 2 | 0.00 | 23.41 (20.97 of it from the hearth) | 471.88 | 0 | demo-bot-early-a | - |
| 6 | LIT | 471.88 | 606.78 | 4 | 18.87 | 0.00 | 504.91 | 1 | demo-bot-early-a | demo-bot-steady (171.57) |
| 7 | LIT | 504.91 | 575.28 | 4 | 20.19 | 0.00 | 540.26 | 2 | demo-bot-early-a | demo-bot-late (100.00) |

After the seventh night: supply 3,100,086.69 EMBER, hearth 2,999,990.04, longest streak 4, tallest fire 504.92, 6 lit nights and 1 smoky one, 296,701 bytes of storage. The coin's icon read `LIT ×2`, with six flames and one grey puff along the bottom. Real gas as on staging: a throw 2.7-3.3 Tgas, a settle 2.7-2.8, a `collect` 2.4, a signed collect 2.65.

From then on the fire burns when someone plays: the page settles the nights that ended while nobody was there (they settle cold), and `fire.yml` brings the bots back once the secret `BONFIRE_BOTS` is set on the repository.
