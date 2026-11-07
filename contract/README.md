# Bonfire contract

EMBER is an NEP-141 token whose holders build a bonfire together every night. Bring enough wood
and the fire catches: every thrower gets the wood back plus newly minted EMBER. Fall short and part
of the wood goes up in smoke. The rules are in [`../DESIGN.md`](../DESIGN.md); this file is the
contract's API and its limits.

Every rule is a launch parameter, stored once by `new` and shown by `config()`. There is no owner,
no admin method and no upgrade method: after deployment every access key of the contract account
is deleted, and `build.sh` checks that the wasm exports nothing beyond the methods below. The
contract settles exactly like the reference model `sim/bonfire_sim.py` (`tests/golden.rs`).

## Methods that change state

| Method | Arguments | Who may call | Deposit |
|---|---|---|---|
| `new` | `config: Config`, `founders: [{account_id, amount}]` | the contract account, once, in the deployment transaction | none |
| `act` | `player_pubkey`, `nonce`, `action`, `signature` (see below) | anyone (a relayer); acts for the implicit account of `player_pubkey` | none |
| `throw_wood` | `amount: U128`, `night: u32` | any registered account | exactly 1 yoctoNEAR |
| `claim_kindling` | none | any account that never held EMBER | none |
| `settle` | none | anyone | none |
| `collect` | `account_id` | anyone, for anyone | none |
| `ft_transfer` | `receiver_id`, `amount`, `memo` | any registered account | exactly 1 yoctoNEAR |
| `ft_transfer_call` | `receiver_id`, `amount`, `memo`, `msg` | any registered account | exactly 1 yoctoNEAR |
| `ft_resolve_transfer` | `sender_id`, `receiver_id`, `amount` | only the contract itself (the NEP-141 callback) | none |
| `storage_deposit` | `account_id`, `registration_only` | anyone | at least `storage_balance_bounds().min` |
| `storage_withdraw` | `amount` | any registered account (nothing is ever withdrawable) | exactly 1 yoctoNEAR |
| `storage_unregister` | `force` | a self-registered account (see Storage) | exactly 1 yoctoNEAR |

`throw_wood`, `claim_kindling` and `ft_transfer_call` panic when refused; `act` does not (below).

**Throwing from a wallet.** `throw_wood(amount, night)`, or `ft_transfer_call` with `receiver_id`
set to the contract and `msg` `"throw:<night>"`: the contract throws the wood in the same call (no
cross-contract round trip) and returns the whole amount as used. `night` must be
`state().clock_night`, so a transaction that lands a night late fails instead of throwing on the
wrong night. Plain `ft_transfer` to the contract is refused.

**Ritual calls settle first.** `act`, `throw_wood`, `claim_kindling`, `settle`, `collect` and the
throwing `ft_transfer_call` first settle every night that has ended (up to `max_catchup`, see
Limits). A throw is refused while ended nights remain, so wood always lands on the night the clock
says.

**Pull payments.** Settling a night records only its totals. Each thrower is credited with its
wood back and its share (lit) or with the unburned part of its wood (smoked) when it next throws,
transfers (`ft_transfer`, `ft_transfer_call`), unregisters or acts through `act`, or when anyone
calls `collect(account_id)`. `ft_balance_of` and `holder().balance` count that credit from the
moment the night is settled; `holder().credited` and `holder().pending` show the two parts.
Collecting nothing is not an error. A holder can only throw on the burning night, so it is owed for
at most one night: that credit is collected before its next throw.

### `act`: playing from a browser key

The browser makes an ed25519 key; the holder is the implicit account of that key (64 lowercase hex
characters). `player_pubkey` and `signature` are lowercase hex (32 and 64 bytes); the signature
covers the UTF-8 bytes of

    bonfire:v1:<contract account id>:<nonce>:<action>

(`signing_text(nonce, action)` returns exactly this). `nonce` must be above the account's last one
and at most 2^53 - 1. `action` is one JSON action of at most 512 bytes, and names the night it is
for, which must be `state().clock_night`:

    {"throw":{"amount":"5000000000000000000000","night":12}}
    {"claim_kindling":{"night":12}}
    {"transfer":{"receiver_id":"bob.testnet","amount":"10","night":12}}
    {"collect":{"night":12}}

A bad signature, a used nonce or malformed JSON fails the call. Otherwise the call settles overdue
nights, collects what an earlier night owes the account, and runs the action. A refused action
returns `{ok: false, error, nonce, night, settled, collected}`, with the nonce spent if the account
exists. A key whose account does not exist and whose action is refused leaves no trace. Because the
night is signed, a delayed or replayed message can never land on a later night. A relayer can
withhold a signed throw until its night ends; it then fails with nothing lost.

Why not NEP-366 meta-transactions: a delegate action is checked against an access key of the
sender's account on chain, so every visitor would first need an account created for its key, paid
by a sponsor. With `act` the visitor is only a NEP-141 balance inside the contract, which checks
the ed25519 signature itself. The price is a signing scheme of its own, which wallets do not know.

### Playing from a NEAR account, without the relay

The relay keys are a convenience. Any NEAR account can play with its own key and gas, through the
same rules (near-cli-rs; `ME` is an account whose key the CLI holds):

    C=bonfire-coin.testnet; ME=your-account.testnet
    # tonight's number is clock_night
    near contract call-function as-read-only $C state json-args '{}' network-config testnet now
    # 200 EMBER from the hearth, once per account, 4 claims a night
    near contract call-function as-transaction $C claim_kindling json-args '{}' \
      prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as $ME network-config testnet sign-with-keychain send
    # throw 50 EMBER on night 312 (use tonight's clock_night); exactly 1 yoctoNEAR
    near contract call-function as-transaction $C throw_wood json-args '{"amount":"50000000000000000000","night":312}' \
      prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as $ME network-config testnet sign-with-keychain send
    # after dawn: the balance already counts the night's credit; collect writes it
    near contract call-function as-read-only $C ft_balance_of json-args "{\"account_id\":\"$ME\"}" network-config testnet now
    near contract call-function as-transaction $C collect json-args "{\"account_id\":\"$ME\"}" \
      prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as $ME network-config testnet sign-with-keychain send

`ft_transfer_call` with `receiver_id` the contract, `msg` `"throw:<night>"` and 1 yoctoNEAR
throws the same way. If tonight's kindling is handed out, the claim fails until the next night; if
the sponsored accounts are full, `storage_deposit` (0.00211 NEAR, `storage_balance_bounds`) comes
first. Use the signing option your CLI is set up for in place of `sign-with-keychain`.

## Views

| View | Arguments | Returns |
|---|---|---|
| `ft_total_supply`, `ft_balance_of`, `ft_metadata` | NEP-141/148 | `ft_balance_of(account)` includes uncollected credit; `ft_balance_of(contract)` is the pile plus the hearth; the metadata icon is drawn live |
| `storage_balance_bounds`, `storage_balance_of` | NEP-145 | min = max = the largest account record |
| `config` | none | every launch parameter, the founders, genesis time and supply, the supply cap, the account storage cost |
| `state` | none | open night, start and end, `due`, `nights_due`, `clock_night`, `window_now`, `window_end_ms`, `windows` (wood, start pile, weight so far), target, pile, throwers, `reached`, `firestarter`, `last_log`, streak, records, hearth, supply, `owed`, `owed_nights`, kindling left tonight, sponsored accounts, last settled night |
| `records` | none | longest streak, tallest fire (largest target lit), total minted, total burned, lit / smoked / cold nights, kindling claims |
| `night` | `n` | the open night so far, or one of the last `log_keep` settled nights: outcome (`OPEN`, `LIT`, `SMOKED`, `COLD`), target, pile, throwers, minted, hearth cut, burned, hearth burn, next target, streak, supply, firestarter, last log, windows, and what it still owes (`owed`, `uncollected`) |
| `history` | `from`, `limit` (default 100, at most 500) | one row per settled night: night, target, pile, outcome, minted, burned, supply after |
| `holder` | `account_id` | `balance` (= `credited` + `pending`), the night of its wood, its wood by window and their weight (final once settled, as if the night ended now before), nonce, and the sponsored / held / kindled flags |
| `estimate` | `amount` | what `amount` thrown now would weigh if its window closed with it: window, weight, `factor_bp` |
| `recent_throws` | none | the last 16 throws, oldest first: night, window, account, amount, pile after, time |
| `audit` | none | supply, credited balances, pile (tracked and recomputed), hearth, owed, `balanced` (supply = balances + pile + hearth + owed), `ledger` (supply = genesis + minted - burned), storage bytes, NEAR balance, storage stake |
| `signing_text` | `nonce`, `action` | the text `act` expects to be signed |

## Launch parameters

Amounts are base units (`10^decimals` per EMBER) as decimal strings; `_bp` values are basis points
(10000 = 100 % = 1.0). The field names are those of `sim/params.json`, whose two blocks are valid
init arguments (`tests/golden.rs` checks both). `new` refuses anything outside these ranges.

| Parameter | Range | Meaning |
|---|---|---|
| `name`, `symbol` | 1-64 / 1-16 printable ASCII | token metadata |
| `decimals` | 0-24 | token metadata |
| `night_ms` | 1 s - 30 days | length of a night; night 1 starts at the init block |
| `hearth_genesis` | genesis supply > 0, at most 2^112 | the hearth at launch; founders get their allocations on top (at most 64 founders) |
| `target_start`, `target_min` | 1 <= min <= start <= genesis supply | the target on night 1 and its floor |
| `grow_bp` | 0-10000 | after a lit night the target becomes `target * (10000 + grow_bp) / 10000` |
| `shrink_bp` | 0-9999 | after a smoked or cold night, `target * (10000 - shrink_bp) / 10000` |
| `mint_bp` | 0-10000 | a lit night mints this share of its target; it also caps the hearth burn |
| `hearth_cut_bp` | 0-10000 | the hearth's share of that mint |
| `smoke_bp` | 0-10000 | share of a smoked pile that burns |
| `hearth_burn_bp` | 0-10000 | share of the hearth that burns on a smoked night, at most one night's mint |
| `early_max_bp` | 10000-60000 | weight factor on an empty pile, falling linearly to 10000 at the target |
| `late_lit_bp` | 0-10000 | weight factor of wood above the target |
| `pool_windows` | 1-24 | equal windows per night; wood in one window counts as landing together |
| `target_cap_bp` | 0-10000 | the target never exceeds this share of the free supply (supply - hearth - pile); 0: no cap |
| `min_throw` | >= 1 | smallest throw |
| `kindling`, `kindling_per_night` | >= 1, 0-1000 | kindling amount and claims per night |
| `max_catchup` | 1-1000 | most nights one call settles |
| `log_keep` | 1-366 | nights `night(n)` keeps in full |
| `max_accounts` | founders - 1,000,000 | accounts whose storage the contract pays |
| `history_keep` | multiple of 32, 32 - 2^20 | nights `history` keeps |

## The ritual in numbers

Night `n` runs from `genesis + (n-1) * night_ms` to `genesis + n * night_ms`; wood landing
`elapsed` ms into it falls in window `elapsed * pool_windows / night_ms`. When the night is
settled, with `start` the wood of all earlier windows, `x` a window's wood and
`below = min(x, max(target - start, 0))`, the window weighs

    below * early_max - ceil(below * (early_max - 10000) * (2 * start + below) / (2 * target))
        + (x - below) * late_lit

which is the reference model's `below * (early_max * 2T - (early_max - 10000) * (2 * start +
below)) / 2T + above * late_lit`, rewritten so every intermediate fits a u128 at the supply cap. A
thrower's weight is the sum over its windows of `window weight * its wood / x`. Then:

- **LIT** (`pile >= target`): `mint = target * mint_bp / 10000` (never beyond the supply cap) is
  minted to the contract; `cut = mint * hearth_cut_bp / 10000` goes to the hearth; each thrower is
  owed its wood plus `(mint - cut) * weight / total_weight`, where `total_weight` is the sum of the
  window weights. Streak and records update.
- **SMOKED** (`0 < pile < target`): `burn = pile * smoke_bp / 10000` burns; each thrower is owed
  `wood * (pile - burn) / pile`; the hearth burns
  `min(hearth * hearth_burn_bp / 10000, target * mint_bp / 10000)`. The streak resets.
- **COLD** (no wood): nothing burns; the streak resets.
- **Next target**: the rule above, then at most `(supply - hearth - pile) * target_cap_bp / 10000`,
  then at least `target_min`. The floor wins.

**Kindling.** `claim_kindling` (or the `claim_kindling` action) pays `kindling` from the hearth to an
account that has never held EMBER, once. At most `kindling_per_night` claims are paid per clock
night; when the hearth holds less than `kindling`, kindling stops. Nothing else ever leaves the
hearth.

## Rounding

All arithmetic is integer (u128, with a 256-bit intermediate for every `a * b / c`). Every
division rounds down, against the thrower, and every remainder goes somewhere fixed:

| Where | Rule | Where the dust goes |
|---|---|---|
| window weight | the integral rounds down (its subtracted part rounds up) | none: exactly the model's value |
| a thrower's weight | `window weight * wood / window wood`, rounded down | stays out of the total; see below |
| lit shares | each share rounds down | to the hearth when the night's last thrower collects |
| smoked returns | each return rounds down | to the hearth when the night's last thrower collects |
| mint, hearth cut, burn, hearth burn, target | round down | (the burn and hearth burn are exact amounts; the rest stay where they were) |

Two documented differences from the model, both a few base units at most:

- the model divides shares by the sum of the rounded per-throw weights, the contract by the sum of
  the window weights (it cannot sum per-thrower values without visiting every thrower), so a share
  can be one base unit lower; the model also rounds per throw, the contract per thrower and window;
- the model moves rounding dust to the hearth at settlement, the contract when the night's last
  thrower collects; until then it counts as owed, and as free supply for the target cap.

The golden scenarios keep these at zero and match the model exactly. Splitting wood over more
accounts can only lose: ten accounts throwing X/10 in the same window end the night with at most 9
base units less than one account throwing X, and nobody else's result changes at all
(`tests/sybil.rs`). The total supply never exceeds 2^112 base units, which keeps every weight and
sum of weights inside a u128 with `early_max_bp` up to 60000.

## Events (NEP-297)

The contract account holds the pile, the hearth and what settled nights owe their throwers, and
the standard events say so, so replaying them gives every credited balance
(`tests/invariant.rs`, `tests/golden.rs`):

| Event | When |
|---|---|
| `nep141 ft_mint` | genesis (memo `genesis`, `genesis hearth`); a lit night mints its whole mint to the contract (memo `night N lit`) |
| `nep141 ft_burn` | smoke from the pile and from the hearth, from the contract (memos `night N smoke`, `night N hearth smoke`); a forced unregister (`unregister`); the NEP-141 refund corner case (`refund`) |
| `nep141 ft_transfer` | throws (holder to contract, `throw`), collections (contract to thrower, `night N collect`), kindling (contract to holder, `kindling`), transfers |
| `bonfire throw` | `{night, window, account, amount, pile, target, firestarter, last_log}`; the two flags mark the night's first throw and the throw that crossed the target |
| `bonfire lit` | `{night, target, pile, throwers, minted, hearth_cut, shared, weight, target_next, streak, supply, firestarter, last_log: {account, amount}}` |
| `bonfire smoked` | `{night, target, pile, short, throwers, burned, back, hearth_burned, target_next, supply, firestarter}` |
| `bonfire cold` | `{night, target, target_next}` |
| `bonfire kindling` | `{night, account, amount, hearth, left_tonight}` |

Each call logs one line per event kind, with all its entries in the `data` array, in the order
`ft_mint`, `ft_burn`, `ft_transfer`, then the `bonfire` events. The NEP-141 lines are byte for byte
what near-contract-standards writes. Until a thrower collects, its `ft_balance_of` is ahead of the
event log by its credit; the contract's replayed balance is the pile, the hearth and what is owed.

## Limits

**No cap on throwers.** Settling a night touches no thrower, so its gas and its events do not grow
with them; every thrower collects in its own call. The worst settled night logs about 920 bytes.

**Catch-up.** One call settles at most `max_catchup` nights, and fewer if the next night's events
would not fit in 15,360 bytes of logs (NEAR fails a receipt over 16,384; the rest is kept for the
call's own events). Cold nights log about 50 bytes each, so with `max_catchup` 1000 one call
settles about 300 of them. Call `settle` until `nights_due` is 0; the page does this on its own.

**Gas.** The mock VM of the unit tests meters host calls (storage, logs, signature checks), not
wasm instructions. Measured host gas (`tests/gas.rs`):

| Call | Host gas |
|---|---|
| `settle`: a lit night of 300 throwers plus 29 cold nights | 2.9 Tgas |
| `settle`: 300 cold nights in one call (`max_catchup` 1000) | 8.6 Tgas |
| `collect`: one thrower of a lit night | 0.25 Tgas |
| `collect`: wood in all 24 windows | 0.24 Tgas |
| `act` claiming kindling (new sponsored account) | 0.5 Tgas |
| `act` throwing | 0.6 Tgas |

Wasm execution adds an estimated 50,000 instructions per settled night (the window integrals with
256-bit divisions, two JSON entries, the night log and history row) and 20,000 per collection, at
about 0.82 Ggas each: about 1.2 Tgas for 30 nights. With contract loading and the function-call
fees, the worst `settle` with `max_catchup` 30 stays under 10 Tgas, and `collect` under 3 Tgas.
Attach 30 Tgas to `settle`, `collect` and `act`.

## Storage

| Item | Bytes | Paid by | Bound |
|---|---|---|---|
| contract code | 289,280 | the contract account | fixed |
| account record (64-character id) | 135, up to 211 with wood in all 4 windows (+17 per extra window) | the contract for founders and kindling claimers, the holder for `storage_deposit` (charged at the maximum) | sponsored: `max_accounts`, filling at most `kindling_per_night` per night |
| record of a settled night with wood | up to 246 (lit, 4 windows), 118 (smoked) | the contract | one per night until its last thrower collects |
| night log | 192 (cold) up to 472 | the contract | `log_keep` slots, reused |
| history | 69 per night, in buckets of 32 (2,257 bytes) | the contract | `history_keep` nights, then the oldest bucket is reused |
| recent throws, founders list, root state | about 1,900 + 84 per founder + 700 | the contract | fixed |

Every byte costs 10^19 yoctoNEAR (0.00001 NEAR) of storage stake from the contract account. The
contract needs at most

    code + 2,600 + 84 * founders + 211 * max_accounts + 472 * log_keep
         + 2,257 * history_keep / 32 + 246 * (settled nights with uncollected throwers)

bytes: with the launch values (1,664 accounts, `log_keep` 14, `history_keep` 1,024) about
730 KB, 7.3 NEAR, before uncollected nights; with the testnet values (4,505 accounts, `log_keep`
48, `history_keep` 4,096) about 1.56 MB, 15.6 NEAR, reached only when every sponsored account is
taken. A night whose throwers never collect keeps its record; anyone can clear it by calling
`collect` for each thrower named in its `throw` events. If the stake ever runs short, calls that
add storage fail until anyone sends NEAR to the contract account; nothing is lost.

A new browser key is registered by its first successful kindling claim, the only action that can
succeed for a key without EMBER; that is why sponsored registrations fill at most
`kindling_per_night` per night. To send EMBER to a key that never claimed kindling, someone has to
`storage_deposit` for it first, as with any NEP-141 token.

`storage_unregister` works only for accounts that registered themselves with `storage_deposit` and
never took kindling: an account whose storage the contract paid cannot withdraw that NEAR, and an
account that took kindling stays registered so the once-only rule holds. It collects first; wood
on the burning night must be settled first; `force` burns a remaining balance with an `ft_burn`
event.

## Sybil resistance and its limits

Rewards are proportional to wood and its window; splitting a balance over many accounts earns
nothing (see Rounding). Pooled windows contain the holder who covers the whole target alone at the
opening bell: everyone who throws in the same window shares the bottom of the pile with it, pro
rata (`tests/sybil.rs`: with the community's 10,000 in its window it keeps two thirds of the
throwers' mint, with the community a window later 95 %). Accounts matter only for kindling:
implicit accounts cost nothing, so the "once per account" rule alone stops nobody. What bounds a
farmer is `kindling_per_night` claims per night from a finite hearth: draining it is slow, mints
nothing new, and slows newcomers. `max_accounts` caps the storage the contract pays, so a farmer
can also exhaust the sponsored seats; after that newcomers need a `storage_deposit` from a wallet.

What the rules do not stop: showing up compounds. A lit night pays its throwers new EMBER by
weight, so a holder that throws safely every night gains share from everyone who throws less. The
target cap keeps one night's mint at or below 1 % of the free supply (25 % times `mint_bp` 4 %);
it limits the rate, not the level, and not any holder's share. A holder with at least 25 % of the
free supply can always cover the target alone (unless `target_min` is above the cap). Numbers
over 365 nights:
[`../docs/SIMULATION.md`](../docs/SIMULATION.md#a-year-with-the-launch-values-what-compounds).

## Checking the deployment

- No keys: `{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"<contract>"}}`
  returns `"keys":[]`.
- The code: `view_account` returns `code_hash`, the base58 form of the sha256 in `WASM_SHA256`.
  That this is the build of this source is shown only by rebuilding it (next section).
- The parameters: `config()`. The books: `audit()`.

## Rebuilding the deployed wasm

`WASM_SHA256` is a number written next to the source; on its own it proves nothing about it. The
evidence is a rebuild that gives the bytes the chain holds:

    ./build.sh --check
    python3 compare-wasm.py target/near/bonfire.wasm --account bonfire-coin.testnet

`compare-wasm.py` (Python standard library only) fetches the deployed code with the RPC `view_code`
query, checks it against the chain's code hash and compares it with the local wasm section by
section. It exits 0 only if the two are byte-identical; otherwise it names the sections that differ
and, inside them, the function bodies and data byte ranges.

| Where | Result |
|---|---|
| macOS 15 x86_64 (a 4-core Intel Mac): cold builds into two different target directories | byte-identical to the code on chain |
| the same Mac, from a copy at another path, with the cargo and rustup homes at other paths | byte-identical to the code on chain |
| CI job `wasm` on GitHub's `macos-15-intel`, every push | must be byte-identical to the code it reads from the chain, or the run fails |
| CI job `wasm` on `ubuntu-latest` (Linux x86_64) and `macos-15` (arm64) | reported in the job summary with the section comparison, the wasm uploaded as an artifact; a difference does not fail the run |

**Why Linux differed, and what the host pin fixes.** Before the pin, CI built `5d901928…` on Linux
in every run, not the deployed `c8bdff7e…`. One cause is cargo, not the source: cargo hashes the
`host:` line of `rustc -vV` into the `-C metadata` of every proc macro and build script and mixes
those hashes into the crate hashes of everything that depends on them
([rust-lang/cargo#8140](https://github.com/rust-lang/cargo/issues/8140)). The contract's crates
therefore get other symbol hashes on another host, and rustc lays out the code by symbol name. On
the same Mac, `PINNED_HOST=x86_64-unknown-linux-gnu ./build.sh --check`, which only tells cargo
it runs on Linux, gives `951f95c1…`: 700 functions instead of 704, only 60 function bodies identical
at the same position, imports, element table and string data in another order, the embedded ABI
unchanged. `build.sh` now pins the host cargo sees to `x86_64-apple-darwin`, the deployed build's,
with a small `RUSTC_WRAPPER` that rewrites that one line of `rustc -vV`; proc macros and build
scripts still run natively, and the deployed code stays as it is.

**What is not explained.** `951f95c1…` is not the Linux hash either. The rest lies in the Linux
builds of the tools (rustc with its LLVM and wasm linker, or cargo-near with its built-in wasm-opt
pass and ABI extraction); which one could not be narrowed down without a Linux machine. CI now
uploads the Linux wasm and prints its section comparison, so the first run with the pin shows what
is left. Until a Linux run comes out byte-identical, the rebuild is established on macOS x86_64
only.

**Not covered.** The build uses cargo-near's `non-reproducible-wasm` mode with pinned inputs (Rust
1.95.0 from `rust-toolchain.toml`, the cargo-near 0.22.0 release binary, `Cargo.lock`), not
cargo-near's Docker-based reproducible mode, so the contract's NEP-330 metadata says
`build_info: null` and names no source. Windows is untested.

## Build and test

    cargo test                 # unit tests in the SDK's mock VM; no sandbox, no network
    ./build.sh                 # privacy-safe wasm build: writes WASM_SHA256
    ./build.sh --check         # rebuild and compare with WASM_SHA256
    python3 tests/golden_sim.py   # the golden numbers from the reference model, to paste into tests/golden.rs

`build.sh` needs cargo-near 0.22, the toolchain pinned in `rust-toolchain.toml`, `strings`,
`python3` and `sha256sum` or `shasum`. It remaps every machine path in the wasm to a neutral prefix,
pins the host triple cargo hashes (see above), fails if `/Users/`, `/home/` or the user name remain,
and fails if the wasm exports anything but the methods above (plus `contract_source_metadata` and
the embedded ABI).

| Test file | Covers |
|---|---|
| `golden.rs` | two scenarios settled night by night against `sim/bonfire_sim.py`, to the base unit; both blocks of `sim/params.json` accepted at init |
| `ritual.rs` | lit, smoked and cold nights with exact numbers, pile-position weights, pooled windows, the target cap and floor, the capped hearth burn, firestarter and last log, no thrower cap, night guards, `ft_transfer_call` throws |
| `lazy.rs` | credit counted before collection, collection by anyone, a holder back after 30 nights, every balance-changing call collecting first, a night's record going with its last thrower |
| `catchup.rs` | batch catch-up, throws during a backlog, history ring, night logs |
| `kindling.rs` | once per account, cap per night, dry hearth, sponsored registrations and `max_accounts` |
| `token.rs` | NEP-141/145/148, event format, `ft_transfer_call` refunds, unregistering |
| `signature.rs` | signatures, nonces, replay, night binding, refused actions |
| `init.rs` | every parameter range, `config()` round trip, the worst night's logs |
| `invariant.rs` | randomized multi-night play: conservation after every call, event replay, nothing owed after everyone collected |
| `sybil.rs` | one account versus ten in the same window for early, crossing, late and smoky wood; the solo lighter's share |
| `gas.rs` | host gas and logs of settle, catch-up and collect |
| `storage.rs` | measured bytes per account, night, night log and history row |
| `icon.rs` | the icon is a small valid SVG data URL with the last night's word and the last seven nights |
| `surface.rs` | no state-changing method beyond the ritual and NEP-141/145, one private init, no key or code actions |
