<p align="center"><img src="docs/shots/night.png" alt="The Bonfire page mid-night: the fire on the pile, the countdown to dawn, the Tonight card with the pile against the target, and the player's wood" width="760"></p>

# Bonfire

[![CI](https://github.com/replaycourt/bonfire/actions/workflows/ci.yml/badge.svg)](https://github.com/replaycourt/bonfire/actions/workflows/ci.yml)

**A memecoin you light together.** Every night the holders of EMBER build one bonfire. Throw EMBER on the pile before dawn. Enough wood and the fire catches: everyone gets their wood back plus new EMBER, and the wood that went on the cold pile earns the most. Too little and part of the pile goes up in smoke. Every dawn is a small cliff-hanger: does it catch, who lit it, who threw the last log, how long does the streak run? Every rule lives in one NEAR contract that has no access keys, so nobody can change it. On testnet a night lasts five minutes.

**Play now:** https://replaycourt.github.io/bonfire/web/ (testnet, EMBER has no value, no wallet, no sign-up)

**Demo video:** [web/media/bonfire-demo.mp4](web/media/bonfire-demo.mp4)

**Judging?** [JUDGE.md](JUDGE.md) is a five-minute path: what to tap, what you should see, the one-command checks, and where each claim lives in the code. `scripts/judge-checks.sh` runs six read-only checks against the live contract and prints PASS or FAIL.

<table>
<tr>
<td width="38%"><img src="docs/shots/dawn.png" alt="The dawn banner over the fire: the night's outcome, what the throwers got, the firestarter and the last log"></td>
<td width="38%"><img src="docs/shots/story.png" alt="The strip of the last nights, the supply chart, the records and the coin's face drawn by the contract"></td>
<td width="24%"><img src="docs/shots/phone.png" alt="The page on a phone: the fire, the countdown and the Tonight card"></td>
</tr>
<tr>
<td><sub><b>Dawn</b>: the night settles on chain and the banner says how it ended, who lit it and who closed the gap.</sub></td>
<td><sub><b>The story so far</b>: every night as a flame, a puff of smoke or a cold ring, supply night by night, records, and the coin's face.</sub></td>
<td><sub><b>On a phone</b>: the same page.</sub></td>
</tr>
</table>

<sub>Screenshots of the page against the live contract `bonfire-coin.testnet` while the demo bots played, taken with headless Chrome; the screenshot tabs sent no transaction.</sub>

## How to play

1. **Open the page.** First it replays last night in five seconds: the pile rises against its target, then dawn and the banner (*Replay of last night*). See tonight's fire, the countdown to dawn with the night's four quarters, and the *Tonight* card: how much wood the fire still needs, the pile against the target, what wood counts right now (×4 on an empty pile), the streak, the firestarter and the last log. The five demo bots appear by name (`demo-bot-early-a` and so on).
2. **Tap *Get kindling*.** See 200 EMBER arrive from the hearth, the contract's treasury. There is no wallet prompt: your browser made an ed25519 key, and that key's implicit account holds your EMBER. The hearth pays 4 claims a night; when they are gone the page counts down to the next dawn.
3. **Pick a chip (for example 25, 50, 100 or *All in*).** Before you tap, the hint says what that wood counts now and about how much new EMBER it brings if the fire catches. Tap, and see your log fly onto the pile, the meter climb, and *Your wood tonight* and *If it catches* fill in.
4. **Wait for dawn.** See the banner: *Night N · LIT ×n, The fire caught!* with your wood back plus your share, or *Up in smoke* with what burned, and the night's firestarter and last log.
5. **Tap *Collect*,** or simply throw again: the next throw collects first. Your balance already counted the credit, as `ft_balance_of` does; collecting writes it into your account.
6. **Scroll down and tap *Proof*.** See the last nights as flames, smoke puffs and cold rings, the supply night by night, the records, and the coin's face as the contract draws it. *Proof* shows the contract, its 0 access keys, the code hash checked against this repository, and every transaction this tab sent.

## The mechanic

**One night, three endings.** At dawn anyone may call `settle()` (the page does it on its own):

| Ending | When | What happens |
|---|---|---|
| **LIT** | the pile reached the target | Every thrower is owed all its wood back. The contract mints 4 % of the target: 10 % of it goes to the hearth, the rest to the throwers by weight. The target grows 7 %, the streak grows. |
| **SMOKED** | some wood, but short of the target | 3 % of the pile burns, the rest goes back pro rata. The hearth burns 0.25 % of itself, at most one night's mint. The target shrinks 10 %, the streak resets. |
| **COLD** | nobody threw | Nothing burns. The target shrinks 10 %, the streak resets. |

The target never exceeds 25 % of the free supply and never falls below its floor (100 EMBER on testnet).

**Kindlers earn most.** Wood is weighted by its place in the pile: the factor falls from ×4 on an empty pile to ×1 at the target, and wood above the target counts ×0.25. Whoever kindles the cold pile takes the smoke risk and earns the most; whoever warms their hands at a fire that is already safe earns a little.

**Quarters pool.** Each night is cut into four equal windows (75 seconds on testnet, six hours at the launch values). All wood that lands in the same quarter counts as landing together and shares that quarter's slice of the pile pro rata. Nobody owns the bottom of the pile by being first in a block, and splitting wood over many accounts earns nothing: ten accounts throwing X/10 in one quarter end the night with what one account throwing X gets, less at most one base unit each.

**The hearth: a treasury with rules.** It started with 3,000,000 EMBER on testnet. It gives 200 EMBER of kindling, once, to any account that never held EMBER, at most 4 claims a night. It is refilled by 10 % of every lit night's mint and burns a little on every smoky night. Nobody can withdraw from it; it has no owner.

**Pull payments.** Settling records only the night's totals, so it costs the same with five throwers or five thousand. Each thrower is credited when it next acts, or when anyone calls `collect(account)` for it.

**The coin's face.** `ft_metadata().icon` is an SVG the contract draws from its own state: at the top `LIT ×12` (letters that grow with the streak), `SMOKED` or `COLD`; in the middle last night's fire; along the bottom the last seven nights. Every wallet that lists EMBER shows the fire.

The full rules are in [DESIGN.md](DESIGN.md), the API and its limits in [contract/README.md](contract/README.md).

## Fits the track

The `memecoins` prompt: *"Build memecoins where the meme does something: supply that reacts to the community, treasuries with rules, onchain rituals and challenges. Judged on the mechanic, not the chart."*

| The track asks for | In Bonfire | Where to check |
|---|---|---|
| Supply that reacts to the community | Lit nights mint 4 % of the target; smoky nights burn 3 % of the pile and part of the hearth; the target follows what the community throws (+7 % lit, −10 % smoked or cold). | `settle_night`, `next_target` in `contract/src/ritual.rs`; `contract/tests/ritual.rs`; live: `history()` |
| Treasuries with rules | The hearth: kindling for newcomers, refilled from every mint, burned on smoky nights, no withdrawal. | `do_claim_kindling`, `settle_night` in `contract/src/ritual.rs`; `contract/tests/kindling.rs`; live: `state().hearth` |
| Onchain rituals and challenges | One fire a night with a target to reach, a streak, records, and a named firestarter and last log. | live: `state()`, `records()`, `night(n)` |
| An NEP-141 token with the mechanic in the contract | EMBER is NEP-141 (with NEP-145 storage and NEP-148 metadata); throws, settling and payouts are contract code. | `contract/src/token.rs`, `contract/src/ritual.rs`; `contract/tests/token.rs` |
| All parameters fixed at launch and readable, no admin key | Every rule is an init argument shown by `config()`; no method changes them; the contract account has no access keys. | `scripts/judge-checks.sh` checks 1, 2 and 4; `contract/tests/surface.rs`; `contract/build.sh` export check |
| Sybil resistance good enough for a demo, limits written plainly | Pooled quarters, rewards pro rata to wood, kindling capped per night, sponsored accounts capped. | `contract/tests/sybil.rs`, `contract/tests/kindling.rs`; [Honest limits](#honest-limits) |
| A page with the streak, progress and a log of mints and burns | Streak on the *Tonight* card and the coin's face; the pile meter against the target and the quarter bar; the strip of the last 24 nights, a supply chart night by night, total minted and burned, and a dawn banner with the night's mint or burn. Per-night amounts: `history()` and the `ft_mint` / `ft_burn` events. | `web/`; `web/test/` |
| A 60-day simulation first | 60-night runs of nine scenarios and a parameter sweep picked the launch values; a golden test settles two scenarios in the contract exactly as the model does. | [docs/SIMULATION.md](docs/SIMULATION.md); `sim/bonfire_sim.py`; `contract/tests/golden.rs` |

## Why NEAR

- **A contract nobody can change.** After deployment every access key of `bonfire-coin.testnet` was deleted ([docs/testnet-launch.md](docs/testnet-launch.md)). There is no owner, admin or upgrade method; `contract/build.sh` fails if the wasm exports anything beyond the ritual, NEP-141/145/148 and the views.
- **Play without a wallet, through function-call keys.** The page makes an ed25519 key and signs `bonfire:v1:<contract>:<nonce>:<action>`. Anyone can relay it to `act`, which checks the signature and the nonce and acts for that key's implicit account. Eight public function-call keys on `bonfire-gas.testnet` pay the gas; each may only call `act`, `settle` and `collect` on the contract, with a 0.5 NEAR allowance. A key holder can relay only what a player signed. Wallet users call `throw_wood`, or `ft_transfer_call` with msg `"throw:<night>"`.
- **NEP-141 with a dynamic icon.** EMBER is an ordinary fungible token: `ft_balance_of` and `ft_transfer` work as usual, and the balance already counts what a settled night owes. `ft_metadata().icon` changes with every settled night.
- **NEP-297 events.** The standard `ft_mint`, `ft_burn` and `ft_transfer` lines, as near-contract-standards writes them, plus `bonfire` events `throw`, `lit`, `smoked`, `cold` and `kindling`. Replaying the events gives every balance (`contract/tests/invariant.rs`).
- **Cheap.** On testnet a throw burns about 3 Tgas, a settle about 2.8 and a collect about 2.4 ([docs/testnet-stage.md](docs/testnet-stage.md)).

## Check it without an account

Plain curl against the public testnet RPC; python3 only decodes the view result, which the RPC returns as bytes. Run from the repository root.

```sh
# The contract has no access keys. Expect: "keys":[]
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"bonfire-coin.testnet"}}'; echo

# No EMBER appears or vanishes. Expect: "balanced":true and "ledger":true
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"bonfire-coin.testnet","method_name":"audit","args_base64":"e30="}}' | python3 -c 'import json,sys; print(bytes(json.load(sys.stdin)["result"]["result"]).decode())'

# The deployed code is the build in this repository. Expect: two equal lines
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"bonfire-coin.testnet"}}' | python3 -c 'import json,sys,functools; s=json.load(sys.stdin)["result"]["code_hash"]; a="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; print(functools.reduce(lambda n,c: n*58+a.index(c), s, 0).to_bytes(32,"big").hex())'; cat contract/WASM_SHA256

# Every launch parameter, fixed at init. Expect: night_ms 300000, kindling_per_night 4, the five founders
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"bonfire-coin.testnet","method_name":"config","args_base64":"e30="}}' | python3 -c 'import json,sys; print(json.dumps(json.loads(bytes(json.load(sys.stdin)["result"]["result"])), indent=1))'
```

## Simulation

Before the contract was final, [docs/SIMULATION.md](docs/SIMULATION.md) ran nine scenarios for 60 nights each (8 seeds, medians), swept the main knobs, and picked the launch values in `sim/params.json`. The launch values pass all 13 of its criteria. Key numbers with the launch values:

| | |
|---|---|
| Healthy community | lit on 80 % of nights, longest streak 27, supply 1.112× genesis at night 60 |
| Early wood against a sniper's completing throws, per EMBER | 2.0× in the healthy community, 3.95× in the sniper-heavy one |
| A holder with 12 % of supply that lights alone at the opening second | takes 67 % of the throwers' mint (93 % without pooled quarters) |
| Everyone throws everything (stress case) | supply 1.318× genesis in 60 nights; the target cap holds it (1.65× without the cap) |
| One balance split over 64 accounts | ends within about 2,000 yoctoEMBER (10⁻¹⁹) of the same balance in one account |
| Long-run lit rate, set by +7 % / −10 % | 61 % |

![Total EMBER supply over 60 nights, by scenario](docs/sim/supply.svg)

`python3 sim/bonfire_sim.py scenarios` (standard library only, about 80 seconds) reruns the scenarios and rewrites the tables and charts; on a copy of this repository it reproduced `docs/SIMULATION.md` and the three charts byte for byte. `python3 sim/bonfire_sim.py` adds the parameter sweep (about 20 minutes, per the document). `contract/tests/golden.rs` checks that the contract settles two scenarios exactly like the model, to the base unit.

## What is real and what is not

- **Testnet only.** The contract is `bonfire-coin.testnet`. Nothing runs on mainnet.
- **EMBER has no value.** It is a testnet token with no market. Testnet NEAR only pays gas and storage.
- **Five demo bots keep the fire alive during judging.** `demo-bot-early-a`, `demo-bot-early-b`, `demo-bot-steady`, `demo-bot-late` and `demo-bot-idle` are run by a script, not by people, and the page labels them by those names. They follow fixed, published strategies ([scripts/bots.mjs](scripts/bots.mjs), `testnet.demo_bots` in `sim/params.json`) and do not react to players. They run in GitHub Actions ([.github/workflows/fire.yml](.github/workflows/fire.yml)): every six hours, for just under six hours, and the workflow reads their keys only from a repository secret. They play by the same rules as everyone: their own keys, signed `act` calls through the same public gas keys, the same contract. Their one difference: they are the founders, so they got 100,000 of the 3,100,000 genesis EMBER instead of kindling.
- **The gas keys are public, on purpose.** They are in [web/js/config.js](web/js/config.js). Anyone can spend their allowance, which pauses free play until the pool is refilled; they cannot touch anyone's EMBER.
- **The fire moves when someone calls.** The night clock runs on block time, but a night is settled by the next call (the page, the bots, or anyone). Nights nobody played settle cold, up to 30 per call.
- **The evidence comes from scripts.** The testnet runs so far were driven by scripts and headless browsers ([docs/testnet-stage.md](docs/testnet-stage.md), [docs/testnet-page-run.md](docs/testnet-page-run.md)), and the simulation models people with simple rules.

## Honest limits

- **A whale that lights alone is contained, not removed.** A holder whose balance covers the target can throw it all in the first second, and the fire can no longer smoke. Pooled quarters make everyone who throws in that first quarter share the bottom of the pile with it. In the simulation, a holder with 12 % of supply still takes about 67 % of the mint, without risk; its share depends on how much the community throws in the first quarter (`contract/tests/sybil.rs`: two thirds with the community in the same quarter, 95 % with the community a quarter later).
- **An exact-gap sniper earns within about 1.3× of early wood.** Inside a quarter every unit gets the quarter's average factor, so wood that exactly closes the gap in the last quarter is not the top of the pile alone. At `late_lit` 0.25 the model's sniper also warms a safe fire, and its wood as a whole earns 2-4× less than early wood (docs/SIMULATION.md, finding 3).
- **A kindling farm drains the hearth at a fixed rate.** Implicit accounts cost nothing, so "once per account" stops nobody. A script that wins every claim takes at most 200 EMBER × 4 claims × 12 nights = 9,600 EMBER an hour, so emptying the 3,000,000 EMBER hearth takes at least 312.5 hours (13 days), refills not counted. While it wins every claim, no newcomer gets kindling. At the launch values the rate is 2,500 EMBER a night.
- **4,505 sponsored seats.** The contract pays storage for the five bots and 4,500 kindling claimers. A farm that wins every claim fills them in 1,125 nights, about 94 hours. After that a newcomer needs someone with a NEAR wallet to call `storage_deposit` for its account before it can claim kindling.
- **`estimate()` uses the stored target while nights are due.** It applies the target floor but not the shrink of the unsettled nights, so during a backlog it shows a different factor than the throw will get. It is a view only: no amount is affected, and the page does not ask for it while a night is due.
- **AI-generated code.** An AI coding agent (Claude) wrote the code and documentation from a human's brief during the hackathon window. The evidence that it works: 121 contract tests, a golden test that settles two scenarios exactly as the simulation does, `audit()` balanced on every night on chain, and the staging and launch runs on testnet. No human reviewed it line by line, and the contract has not been audited.

## Run it yourself

The page is static files with no build step and no dependencies: `web/index.html`, CSS and ES modules. Serve the repository root and open `/web/`:

```sh
python3 -m http.server 8765 --bind 127.0.0.1
# live testnet contract:      http://127.0.0.1:8765/web/
# made-up data, no chain:     http://127.0.0.1:8765/web/?mock=1
```

It needs Ed25519 in WebCrypto: Chrome 137+, Safari 17+ or Firefox 130+. The page has a strict Content-Security-Policy (`default-src 'self'`; connections only to the two testnet RPC hosts) and loads nothing from a CDN.

**Tests.**

```sh
node --test 'web/test/*.test.mjs'       # 84 tests: page logic, signing, RPC fallback, config; about 5 s
node --test 'scripts/test/*.test.mjs'   # 7 tests: relay nonce retries, bot key secret; offline, about 50 s
cd contract && cargo test               # 121 tests; cold build about 8.5 minutes, then about 1 s
scripts/judge-checks.sh                 # 6 read-only checks of the live contract; about 5 s
```

CI runs the three test suites on every push, rebuilds the wasm on Linux and writes in its job summary whether the hash matches `contract/WASM_SHA256`. Node 22 or newer, no install. `cargo test` uses the toolchain pinned in `contract/rust-toolchain.toml` (Rust 1.95.0); the tests run in the SDK's mock VM, with no sandbox and no network.

**Build.** `cd contract && ./build.sh --check` rebuilds the wasm with cargo-near 0.22 and compares its sha256 with `contract/WASM_SHA256`, the code hash on chain. It also fails if the wasm carries machine paths or exports an unexpected method. A cold rebuild on a 4-core laptop (macOS, x86_64) took about 5 minutes and matched.

**Your own deployment.** `scripts/setup-gas-pool.mjs` adds relay keys to a gas account, and `scripts/deploy.mjs <account> [--lock]` deploys with the account's key from the NEAR CLI's legacy keychain, initialises with the testnet values, verifies, and with `--lock` deletes every access key. Both are described in [docs/testnet-stage.md](docs/testnet-stage.md).

## Hackathon note

Built at NEAR HACKATHON for the `memecoins` track. The relay and signing code (`web/js/near.js`, `web/js/chain.js`, `scripts/near-lite.mjs`) is adapted from the author's other, independent entry.

The same author also entered the independent project Lantern Row, https://github.com/replaycourt/lantern-row, in this hackathon.

## Credits

Art drawn in code (Canvas 2D and SVG), sounds synthesised in WebAudio. Libraries: near-sdk and near-contract-standards in the contract; ed25519-dalek and near-parameters in its tests only. The page and the scripts use nothing beyond the browser and Node's standard library.

## License

MIT, see [LICENSE](LICENSE).
