# Bonfire contract

EMBER is an NEP-141 token whose holders build a bonfire together every night. Bring enough wood
and the fire catches: every thrower gets the wood back plus newly minted EMBER. Fall short and part
of the wood goes up in smoke. The rules are in [`../DESIGN.md`](../DESIGN.md); this file is the
contract's API and its limits.

Every rule is a launch parameter, stored once by `new` and shown by `config()`. There is no owner,
no admin method and no upgrade method: after deployment every access key of the contract account
is deleted, and `build.sh` checks that the wasm exports nothing beyond the methods below.

## Methods that change state

| Method | Arguments | Who may call | Deposit |
|---|---|---|---|
| `new` | `config: Config`, `founders: [{account_id, amount}]` | the contract account, once, in the deployment transaction | none |
| `act` | `player_pubkey`, `nonce`, `action`, `signature` (see below) | anyone (a relayer); acts for the implicit account of `player_pubkey` | none |
| `throw_wood` | `amount: U128`, `night: Option<u32>` | any registered account | exactly 1 yoctoNEAR |
| `claim_kindling` | none | any account that never held EMBER | none |
| `settle` | none | anyone | none |
| `ft_transfer` | `receiver_id`, `amount`, `memo` | any registered account | exactly 1 yoctoNEAR |
| `ft_transfer_call` | `receiver_id`, `amount`, `memo`, `msg` | any registered account | exactly 1 yoctoNEAR |
| `ft_resolve_transfer` | `sender_id`, `receiver_id`, `amount` | only the contract itself (the NEP-141 callback) | none |
| `storage_deposit` | `account_id`, `registration_only` | anyone | at least `storage_balance_bounds().min` |
| `storage_withdraw` | `amount` | any registered account (nothing is ever withdrawable) | exactly 1 yoctoNEAR |
| `storage_unregister` | `force` | a self-registered account (see Storage) | exactly 1 yoctoNEAR |

`throw_wood`, `claim_kindling` and `ft_transfer_call` panic when refused; `act` does not (below).

**Throwing from a wallet.** `throw_wood(amount)`, or `ft_transfer_call` with `receiver_id` set to
the contract and `msg` `"throw"`: the contract handles that in the same call (no cross-contract
round trip) and returns the whole amount as used. Plain `ft_transfer` to the contract is refused.

**Ritual calls settle first.** `act`, `throw_wood`, `claim_kindling`, `settle` and the throwing
`ft_transfer_call` first settle every night that has ended (up to `max_catchup`, see Limits). A
throw is refused while ended nights remain, so wood always lands on the night the clock says.

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

A bad signature, a used nonce or malformed JSON fails the call. A refused action does not: the
call returns `{ok: false, error, nonce, night, settled}`, overdue nights it settled stay settled,
and the nonce is spent if the account exists. A key whose account does not exist and whose action
is refused leaves no trace. Because the night is signed, a delayed or replayed message can never
land on a later night.

## Views

| View | Arguments | Returns |
|---|---|---|
| `ft_total_supply`, `ft_balance_of`, `ft_metadata` | NEP-141/148 | `ft_balance_of(contract)` is the pile plus the hearth; the metadata icon is drawn live |
| `storage_balance_bounds`, `storage_balance_of` | NEP-145 | min = max = one account record |
| `config` | none | every launch parameter, the founders, genesis time and supply, the supply cap, the account storage cost, and `max_throwers_limit` |
| `state` | none | open night, its start and end, `due`, `nights_due`, `clock_night`, target, pile, throwers, weight, `reached`, `early_bp_now`, streak, records, hearth, supply, kindling left tonight, sponsored accounts, last settled night |
| `records` | none | longest streak, tallest fire (largest target lit), total minted, total burned, lit / smoke / empty nights, kindling claims |
| `night` | `n` | the open night with its throwers so far, or one of the last `log_keep` settled nights: target, pile, outcome, minted, burned, hearth cut and burn, and every thrower with wood, weight, wood back, reward and wood lost |
| `history` | `from`, `limit` (default 100, at most 500) | one row per settled night: night, target, pile, outcome, minted, burned, supply after |
| `holder` | `account_id` | balance, wood and weight on tonight's pile, nonce, and the sponsored / held / kindled flags |
| `audit` | none | supply, tracked free balances, pile (tracked and recomputed), hearth, `balanced` (supply = balances + pile + hearth), `ledger` (supply = genesis + minted - burned), storage bytes, NEAR balance, storage stake |
| `signing_text` | `nonce`, `action` | the text `act` expects to be signed |

## Launch parameters

Amounts are base units (`10^decimals` per EMBER) as decimal strings; `_bp` values are basis points
(10000 = 100 % = 1.0). `new` refuses anything outside these ranges.

| Parameter | Range | Meaning |
|---|---|---|
| `name`, `symbol` | 1-64 / 1-16 printable ASCII | token metadata |
| `decimals` | 0-24 | token metadata |
| `night_ms` | 1 s - 30 days | length of a night; night 1 starts at the init block |
| `hearth_genesis` | genesis supply > 0, at most 2^112 | the hearth at launch; founders get their allocations on top (at most 64 founders) |
| `target_start`, `target_min` | 1 <= min <= start <= genesis supply | the target on night 1 and its floor |
| `grow_bp` | 0-10000 | target growth after a lit night |
| `shrink_bp` | 0-9999 | target shrink after a smoky or empty night |
| `mint_bp` | 0-10000 | a lit night mints this share of its target |
| `hearth_cut_bp` | 0-10000 | the hearth's share of that mint |
| `smoke_bp` | 0-10000 | share of a smoky pile that burns |
| `hearth_burn_bp` | 0-10000 | share of the hearth that burns on every smoky or empty night |
| `early_max_bp` | 10000-50000 | weight factor at the start of a night |
| `late_lit_bp` | 0-10000 | weight factor of wood landing on a pile already at its target |
| `min_throw` | >= 1 | smallest throw |
| `kindling`, `kindling_per_night` | >= 1, 0-1000 | kindling amount and claims per night |
| `max_throwers_per_night` | 1 - `max_throwers_limit` | distinct throwers per night (see Limits) |
| `max_accounts` | founders - 1,000,000 | accounts whose storage the contract pays |
| `max_catchup` | 1-1000 | most nights one call settles |
| `log_keep` | 1-366 | nights `night(n)` keeps in full |
| `history_keep` | multiple of 32, 32 - 2^20 | nights `history` keeps |

## The ritual in numbers

Night `n` runs from `genesis + (n-1) * night_ms` to `genesis + n * night_ms`. A throw of `amount`
at `elapsed` ms into the night, onto a pile `pile` with target `target`, weighs

    early_bp = early_max_bp - (early_max_bp - 10000) * elapsed / night_ms
    below    = min(amount, max(target - pile, 0))
    weight   = below * early_bp + (amount - below) * late_lit_bp

so wood that crosses the target is early below it and late above it. When a night is settled:

- **lit** (`pile >= target`): every thrower gets the wood back; `mint = target * mint_bp / 10000`
  (never beyond the supply cap), `cut = mint * hearth_cut_bp / 10000` goes to the hearth, each
  thrower gets `(mint - cut) * weight / total_weight`; the target grows by
  `target * grow_bp / 10000` (up to the supply cap); the streak grows; records update.
- **smoke** (`0 < pile < target`): `burn = pile * smoke_bp / 10000` burns, each thrower gets
  `(pile - burn) * wood / pile` back, the hearth burns `hearth * hearth_burn_bp / 10000`; the target
  becomes `max(target_min, target - target * shrink_bp / 10000)`; the streak resets.
- **empty** (no wood): smoke with nothing to burn but the hearth's slice.

**Kindling.** `claim_kindling` (or the `claim_kindling` action) pays `kindling` from the hearth to an
account that has never held EMBER, once. At most `kindling_per_night` claims are paid per clock
night; when the hearth holds less than `kindling`, kindling stops. Nothing else ever leaves the
hearth: it has no owner and no withdrawal method.

## Rounding

All arithmetic is integer (u128, with a 256-bit intermediate for `a * b / c`). Every division
rounds down, and every remainder goes somewhere fixed, so no EMBER appears or vanishes:

| Where | Rule | Where the dust goes |
|---|---|---|
| early factor | the decrement rounds down, so the factor rounds up | (no tokens involved; the same for every throw in the same millisecond) |
| weight | exact | none |
| lit shares | each share rounds down | the difference to `mint - cut` is never minted (`unminted` in the night log) |
| hearth cut, mint | round down | never minted |
| smoke burn | rounds down | stays in the returns |
| smoke returns | each return rounds down | the difference goes to the hearth (`to_hearth`) |
| hearth burn | rounds down | stays in the hearth |
| target | growth and shrink round down | (no tokens involved) |

Every rounding goes against the thrower, so splitting wood over more accounts can only lose: ten
accounts throwing X/10 at the same moment end the night with at most 9 base units less than one
account throwing X, never more (`tests/sybil.rs`). The total supply never exceeds 2^112 base units,
which keeps every weight and every sum of weights inside a u128.

## Events (NEP-297)

The contract account's NEP-141 balance is the pile plus the hearth, and the standard events say
so, so replaying them gives every balance (`tests/invariant.rs` checks exactly that):

| Event | When |
|---|---|
| `nep141 ft_mint` | genesis (memo `genesis`, `genesis hearth`); a lit night mints its total to the contract (memo `night N lit`) |
| `nep141 ft_burn` | smoke from the pile and from the hearth, from the contract (memos `night N smoke`, `night N hearth smoke`); a forced unregister (`unregister`); the NEP-141 refund corner case (`refund`) |
| `nep141 ft_transfer` | throws (holder to contract, `throw`), payouts (contract to thrower, no memo), kindling (contract to holder, `kindling`), transfers |
| `bonfire throw` | `{night, account, amount, weight, early_bp, late, pile, target}` |
| `bonfire lit` | `{night, target, pile, throwers, minted, hearth_cut, unminted, target_next, streak, supply}` |
| `bonfire smoke` | `{night, target, pile, throwers, burned, returned, to_hearth, hearth_burned, target_next, supply}`; an empty night has pile 0 |
| `bonfire kindling` | `{night, account, amount, hearth, left_tonight}` |

Each call logs one line per event kind, with all its entries in the `data` array, in the order
`ft_mint`, `ft_burn`, `ft_transfer`, then the `bonfire` events. The NEP-141 lines are byte for byte
what near-contract-standards writes.

## Limits

**Logs bound the throwers per night.** NEAR fails a receipt whose logs exceed 16,384 bytes. A
settled night pays every thrower in the same call, one `ft_transfer` entry each, so a call may spend
at most 15,360 bytes on settling (the rest is kept for the call's own throw, kindling or transfer).
`new` refuses a `max_throwers_per_night` whose worst case (64-character accounts, amounts at the
supply cap) would not fit; `config().max_throwers_limit` shows the bound, which depends on the
length of the contract's account id: 92 for `fire.near`, 88 for `bonfire.testnet`, 67 for a
64-character id. When the seats are taken, newcomers are refused for that night while seated
throwers can still add wood; `min_throw` makes every seat cost real wood at risk of smoke.

**Catch-up.** One call settles at most `max_catchup` nights, and fewer if the next night's events
would not fit in the log budget: after a full night of 88 throwers the same call has room for one
more empty night; a call of empty nights only settles 30 in about 11 KB. Call `settle` until
`nights_due` is 0; the page does this on its own.

**Gas.** The mock VM of the unit tests meters host calls (storage, logs, signature checks), not
wasm instructions. Measured host gas (`tests/gas.rs`):

| Call | Host gas |
|---|---|
| `act` claiming kindling (new sponsored account) | 1.1 Tgas |
| `act` throwing | 0.6 Tgas |
| `settle` of a lit night with 88 throwers plus one empty night | 18.8 Tgas |
| `settle` of a smoky night with 88 throwers | 18.6 Tgas |
| `settle` of 30 empty nights | 5.5 Tgas |

Wasm execution adds roughly 10,000 instructions per thrower (a 256-bit division, one JSON entry,
two borsh records) at about 0.82 Ggas each: under 1 Tgas for 88 throwers. With contract loading
and the function-call fees, the worst `settle` stays under 25 Tgas, far below the 300 Tgas a
transaction may attach. Gas is not the binding limit; the log budget is. Attach 100 Tgas to
`settle` and `act` to be safe.

## Storage

| Item | Bytes | Paid by | Bound |
|---|---|---|---|
| contract code | 266,567 | the contract account | fixed |
| account record (64-character id) | 166 | the contract for founders and kindling claimers, the holder for `storage_deposit` | sponsored: `max_accounts`, filling at most `kindling_per_night` per night |
| seat on tonight's pile | 113 | the contract | `max_throwers_per_night`, reused every night |
| night log | 218 + 116 per thrower | the contract | `log_keep` slots, reused |
| history | 69 per night, in buckets of 32 (2,257 bytes) | the contract | `history_keep` nights, then the oldest bucket is reused |
| founders list, root state | about 45 + 84 per founder, about 500 | the contract | fixed |

Every byte costs 10^19 yoctoNEAR (0.00001 NEAR) of storage stake from the contract account. The
contract needs at most

    code + 500 + 84 * founders + 166 * max_accounts + 113 * max_throwers_per_night
         + log_keep * (218 + 116 * max_throwers_per_night) + 2,257 * history_keep / 32

bytes; with `max_accounts` 1000, 88 throwers, `log_keep` 14 and `history_keep` 4096 that is about
880 KB, 8.8 NEAR. History grows by 69 bytes per night until `history_keep` is reached (with daily
nights, 4096 nights are 11 years; with 5-minute nights, 14 days). If the stake ever runs short,
calls that add storage fail until anyone sends NEAR to the contract account; nothing is lost.

A new browser key is registered by its first successful kindling claim, the only action that can
succeed for a key without EMBER; that is why sponsored registrations fill at most
`kindling_per_night` per night. To send EMBER to a key that never claimed kindling, someone has to
`storage_deposit` for it first, as with any NEP-141 token.

`storage_unregister` works only for accounts that registered themselves with `storage_deposit` and
never took kindling: an account whose storage the contract paid cannot withdraw that NEAR, and an
account that took kindling stays registered so the once-only rule holds. Wood on tonight's pile
must be settled first; `force` burns a remaining balance with an `ft_burn` event.

## Sybil resistance and its limits

Rewards are proportional to wood and its timing; splitting a balance over many accounts earns
nothing (see Rounding). Accounts matter only for kindling: implicit accounts cost nothing, so the
"once per account" rule alone stops nobody. What bounds a farmer is `kindling_per_night` claims per
night from a finite hearth: draining it is slow, mints nothing new, and slows newcomers.
`max_accounts` caps the storage the contract pays, so a farmer can also exhaust the sponsored
seats; after that newcomers need a `storage_deposit` from a wallet. A griefer with
`max_throwers_per_night` accounts and `min_throw` each could take every seat of a night; that wood
is at risk of smoke like everyone's.

## Checking the deployment

- No keys: `{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"<contract>"}}`
  returns `"keys":[]`.
- The code: `view_account` returns `code_hash`, the base58 form of the sha256 in `WASM_SHA256`
  (`./build.sh --check` rebuilds and compares).
- The parameters: `config()`. The books: `audit()`.

## Build and test

    cargo test                 # unit tests in the SDK's mock VM; no sandbox, no network
    ./build.sh                 # privacy-safe wasm build: writes WASM_SHA256
    ./build.sh --check         # rebuild and compare with WASM_SHA256

`build.sh` needs cargo-near 0.22, the toolchain pinned in `rust-toolchain.toml`, `strings`,
`python3` and `sha256sum` or `shasum`. It remaps every machine path in the wasm to a neutral prefix,
fails if `/Users/`, `/home/` or the user name remain, and fails if the wasm exports anything but the
methods above (plus `contract_source_metadata` and the embedded ABI).

| Test file | Covers |
|---|---|
| `ritual.rs` | lit, smoke and empty nights with exact numbers, weights, crossing throws, target bounds, hearth burn, streak and records, thrower cap, minimum throw, `ft_transfer_call` throws |
| `catchup.rs` | batch catch-up, throws during a backlog, history ring, night logs |
| `kindling.rs` | once per account, cap per night, dry hearth, sponsored registrations and `max_accounts` |
| `token.rs` | NEP-141/145/148, event format, `ft_transfer_call` refunds, unregistering |
| `signature.rs` | signatures, nonces, replay, night binding, refused actions |
| `init.rs` | every parameter range, `config()` round trip |
| `invariant.rs` | randomized multi-night play: conservation after every call, event replay equals balances |
| `sybil.rs` | one account versus ten for early, crossing, late and smoky wood |
| `gas.rs` | worst-case logs and host gas |
| `storage.rs` | measured bytes per account, seat, night log and history row |
| `icon.rs` | the icon is a small valid SVG data URL that follows the fire |
| `surface.rs` | no state-changing method beyond the ritual and NEP-141/145, one private init, no key or code actions |
