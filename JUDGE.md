# Judging Bonfire in five minutes

Everything runs on NEAR testnet against `bonfire-coin.testnet`. You need a browser for the page, and `curl` and `python3` for the checks. No account, wallet or install. A night lasts five minutes, so the path below sees one full night.

## 1. The five-minute path

Open https://replaycourt.github.io/bonfire/web/ in Chrome 137+, Safari 17+ or Firefox 130+. Playing sends real testnet transactions, paid by the public gas pool.

1. **Open the page.** First it replays last night in five seconds: the pile rises against its target, then dawn and the banner (*Replay of last night*). See the fire, *Night N* with the countdown *until dawn* and four quarter segments, and the *Tonight* card: how much wood is still needed before dawn, the pile against the target, *Wood counts now* (×4 on an empty pile, falling as the pile grows), the firestarter and last log (the demo bots by name, for example `demo-bot-early-a`), throwers, streak, hearth, and *Kindling left tonight: n of 4*. If a night ended while nobody was there, the page settles it first (*Dawn · Lighting the fire…*). After the replay, a first visit gets *A whole night in 5 minutes* under *Your wood* (on a phone, under *Get kindling*): three numbered steps whose numbers also mark *Get kindling*, the first chip and the countdown; × or Escape hides them for good, and they go by themselves at the dawn of your first night.
2. **Tap *Get kindling*.** See *Fetching kindling…*, then a toast and *Your EMBER 200*. No wallet prompt: your browser made an ed25519 key, and its implicit account holds the EMBER. If tonight's four claims are gone, the page says *The next claim opens at dawn, in m:ss.*
3. **Throw.** Point at a chip (on a phone, the marked chip is the one the hint describes) and read the hint: *Throw 50 EMBER now: it counts ×3.3, about +x new EMBER if the fire catches.* Tap it. See your log fly onto the pile, the meter rise, and *Your wood tonight* and *If it catches* fill in. Wood thrown in the first 75 seconds shares the bottom of the pile with the early bots; wood that lands after the pile reached the target counts ×0.25.
4. **Wait for dawn.** Under your wood a line counts down to your dawn (*Dawn in m:ss · your 50 wood on the pile*), in the tab title too while you look at another tab, with a short chime at dawn if sound is on. If you threw that night, the banner offers *Save your card*: a picture of your night with the coin's face the contract drew. See the banner *Night N · LIT ×n*, *The fire caught!*, *Your 50 wood comes back, plus x new EMBER.*, and *Firestarter: … · Last log: …*. On a smoky night: *Up in smoke* and how much of your wood came back. The strip of last nights gains a night and the coin's face redraws.
5. **Collect.** Beside *+x from night N is already in your balance. Collect it now, or your next throw will.* tap *Collect*. See the toast *x EMBER collected from your last night.* Or throw again: the throw collects first.
6. **Tap *Proof*.** Under *Try to cheat it*, tap *Throw wood on tomorrow’s fire*: a real transaction breaks a rule, and the toast shows the contract's refusal (*the action is for night N+1, but this is night N*). See the contract, *0 access keys · nobody can change the rules*, the code hash with *· matches the build in the repository*, your account, the gas account, and every transaction this tab sent with its gas, linked to the testnet explorer.

The [README](README.md#how-to-play) walks through the same steps; to run the page locally, or with made-up data (`?mock=1`), see [Run it yourself](README.md#run-it-yourself).

### Play without our relay

The page plays through public relay keys. If they are spent, or you would rather use your own account, any NEAR testnet account plays by the same rules with its own gas (near-cli-rs; all commands, `collect` included, in [contract/README.md](contract/README.md#playing-from-a-near-account-without-the-relay)):

```sh
C=bonfire-coin.testnet; ME=your-account.testnet
near contract call-function as-read-only $C state json-args '{}' network-config testnet now   # tonight is clock_night
near contract call-function as-transaction $C claim_kindling json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as $ME network-config testnet sign-with-keychain send
near contract call-function as-transaction $C throw_wood json-args '{"amount":"50000000000000000000","night":312}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as $ME network-config testnet sign-with-keychain send   # night: tonight's clock_night
```

After dawn `ft_balance_of` already counts your wood back and your share; `collect` writes it. If tonight's four kindling claims are gone, the claim fails until the next night.

## 2. One-command checks (read-only, about 5 seconds)

```sh
scripts/judge-checks.sh
```

It needs bash, curl and python3 (macOS or Linux), sends no transaction, and prints PASS or FAIL for each check. Its exit code is the number of failed checks. Expected:

```
Bonfire: read-only checks of bonfire-coin.testnet against https://test.rpc.fastnear.com
PASS  1. bonfire-coin.testnet has no access keys
PASS  2. code hash on chain = contract/WASM_SHA256
PASS  3. audit(): balanced and ledger hold
PASS  4. config() = sim/params.json testnet block + 2 documented changes
PASS  5. relay keys only call act, collect, settle
PASS  6. ft_metadata().icon shows the last night's outcome (LIT x2)
All 6 checks passed.
```

| Check | What it shows |
|---|---|
| 1 | `view_access_key_list` of the contract is empty: nobody can redeploy it, change a rule or act as it. |
| 2 | The chain's code hash, decoded from base58, equals `contract/WASM_SHA256`. |
| 3 | `audit()`: supply = balances + pile + hearth + owed, and supply = genesis + minted − burned. |
| 4 | `config()` equals the `testnet` block of `sim/params.json` with the two changes in [docs/testnet-launch.md](docs/testnet-launch.md) (`kindling_per_night` 4, `hearth_genesis` 3,000,000 EMBER), and the founders are the five bots labelled in `web/js/config.js`. |
| 5 | Every function-call key on `bonfire-gas.testnet` may only call `act`, `collect` and `settle`; its one full-access key is not in the repository. |
| 6 | The word on the token's icon (`LIT ×n`, `SMOKED` or `COLD`) is the last settled night's outcome from `state()`, both read at the same block. The word in brackets changes with the fire. |

The same checks by hand, as curl one-liners, are in the README: [Check it without an account](README.md#check-it-without-an-account). Check 2 compares two numbers; that `contract/WASM_SHA256` is the build of this source is shown by a rebuild. `cd contract && ./build.sh --check` rebuilds the wasm and compares it with `contract/WASM_SHA256`, and `python3 compare-wasm.py target/near/bonfire.wasm --account bonfire-coin.testnet` compares it with the code on chain, section by section; they need cargo-near 0.22 and the toolchain pinned in `contract/rust-toolchain.toml`. Cold rebuilds on the author's 4-core Intel Mac (macOS 15, x86_64) took about 20 minutes and were byte-identical to the chain. CI repeats the rebuild on every push on Linux, an Intel Mac and an arm64 Mac: the three agree with each other byte for byte, and each job reports how its bytes compare with the chain, section by section. Until 2026-11-07 they differed from the deployed code only in the `builder` field of the embedded ABI, which cargo-near took from a variable the CI job had set; `build.sh` now unsets it. Details: [contract/README.md](contract/README.md#rebuilding-the-deployed-wasm).

## 3. Where each claim lives

| Claim | Code | Tests |
|---|---|---|
| No owner, no admin or upgrade method | `contract/src/lib.rs`: `new` is `#[init] #[private]`; the export list in `contract/build.sh` | `contract/tests/surface.rs` |
| Every parameter fixed at init and readable | `Config::validate` in `contract/src/config.rs`; `config` in `contract/src/views.rs` | `contract/tests/init.rs`; `no_code_assigns_a_launch_parameter_after_init` in `contract/tests/surface.rs` |
| LIT, SMOKED, COLD; the target's growth, shrink, cap and floor | `settle_night`, `next_target` in `contract/src/ritual.rs` | `contract/tests/ritual.rs` |
| Kindlers earn most: weight by place in the pile | `slice_weight`, `window_weights` in `contract/src/math.rs` | `the_weight_falls_with_the_pile_and_the_whole_target_earns_the_average`, `the_same_wood_earns_less_in_a_later_window` in `contract/tests/ritual.rs` |
| Quarters pool; order inside a quarter does not matter | `window_at` in `contract/src/ritual.rs`; `window_weights` in `contract/src/math.rs` | `inside_a_window_the_order_of_throws_does_not_matter` in `contract/tests/ritual.rs` |
| Splitting over accounts earns nothing | as above; shares pro rata in `credit_of` in `contract/src/ritual.rs` | `split_*` in `contract/tests/sybil.rs` |
| A solo lighter shares its quarter | as above | `a_solo_lighter_shares_its_window_with_the_community` in `contract/tests/sybil.rs` |
| The hearth: kindling, refill, capped burn, no withdrawal | `do_claim_kindling`, `settle_night` in `contract/src/ritual.rs` | `contract/tests/kindling.rs`; `a_smoky_night_burns_part_of_the_pile_and_the_hearth_burn_is_capped_by_the_mint` in `contract/tests/ritual.rs` |
| Pull payments, no cap on throwers | `credit`, `credit_of` in `contract/src/ritual.rs`; `pending_credit` in `contract/src/token.rs` | `contract/tests/lazy.rs`; `there_is_no_cap_on_throwers` in `contract/tests/ritual.rs`; `contract/tests/gas.rs` |
| Missed nights settle in a batch | `catch_up` in `contract/src/ritual.rs` | `contract/tests/catchup.rs` |
| No EMBER appears or vanishes | `audit` in `contract/src/views.rs` | `contract/tests/invariant.rs` |
| NEP-141, NEP-145, NEP-148 | `contract/src/token.rs` | `contract/tests/token.rs` |
| NEP-297 events; replaying them gives every balance | `Logs` in `contract/src/events.rs` | `contract/tests/token.rs`, `contract/tests/invariant.rs` |
| The coin's face is drawn from state | `icon`, `label`, `draw` in `contract/src/icon.rs`; `ft_metadata` in `contract/src/token.rs` | `contract/tests/icon.rs` |
| No-wallet play: signature, nonce, night binding | `act`, `run_action`, `signing_message` in `contract/src/lib.rs`; browser key `loadOrCreateIdentity`, signing `Client.act`, relay `GasPool.relay` in `web/js/chain.js` | `contract/tests/signature.rs`; `web/test/near.test.mjs` |
| The contract settles like the simulation | `Fire` in `sim/bonfire_sim.py` | `contract/tests/golden.rs` |
| The page shows the chain's numbers in words | `nightResult`, `throwHint`, `windowsModel` in `web/js/logic.js` | `web/test/logic.test.mjs` |
| The page checks the code hash | `proofHtml` in `web/js/ui.js` | `web/test/ui.test.mjs` |
| Demo bots: labelled, fixed strategies, same rules | `BEHAVIOURS`, `planNight` in `scripts/bots.mjs`; `bots` in `web/js/config.js`; `.github/workflows/fire.yml` | `scripts/test/relay.test.mjs`, `web/test/config.test.mjs` |

The rules in words are in [DESIGN.md](DESIGN.md), the API and its limits in [contract/README.md](contract/README.md), the simulation in [docs/SIMULATION.md](docs/SIMULATION.md), and the testnet runs with their transaction hashes in [docs/testnet-stage.md](docs/testnet-stage.md), [docs/testnet-page-run.md](docs/testnet-page-run.md) and [docs/testnet-launch.md](docs/testnet-launch.md).

## 4. Run the tests

Measured on a 4-core laptop:

```sh
node --test 'web/test/*.test.mjs'       # 94 tests; Node 22+, no install; about 5 seconds
node --test 'scripts/test/*.test.mjs'   # 7 tests, offline (fetch is faked); about 50 seconds
cd contract && cargo test               # 121 tests in the SDK's mock VM; a cold build took 8.5 minutes, the tests about 1 second
python3 sim/bonfire_sim.py scenarios    # reruns the scenarios and rewrites docs/SIMULATION.md's tables and charts; about 80 seconds
python3 sim/bonfire_sim.py longrun      # the launch values over 365 nights; not part of the default run; about 6 minutes
```

The simulation rerun is deterministic: on a copy of this repository it reproduced `docs/SIMULATION.md` and the three charts in `docs/sim/` byte for byte. `python3 sim/bonfire_sim.py` with the parameter sweep takes about 20 minutes.

## 5. What is real and what is not

Testnet only; EMBER has no value; five labelled demo bots, run by GitHub Actions, keep the fire alive by the same rules as everyone; public gas keys; a fire that moves only when someone calls; AI-written code that no human reviewed line by line; no audit. And what the rules do not stop: a holder that lights alone, showing up that compounds over a year, a kindling farm. The details and the honest limits are in the README: [What is real and what is not](README.md#what-is-real-and-what-is-not), [Honest limits](README.md#honest-limits).
