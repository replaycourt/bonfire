# Bonfire: design

A memecoin whose holders build a bonfire together every night. Bring enough wood and the fire catches: everyone who brought wood gets their wood back plus new EMBER. Fall short and part of the wood goes up in smoke. Every rule lives in one NEAR contract with no access keys, so nobody can change it once launched.

Track: Memecoins With Mechanics (`memecoins`). The prompt asks for supply that reacts to the community, treasuries with rules, on-chain rituals and challenges, an NEP-141 token with the mechanic in the contract, every parameter fixed at launch and readable by anyone, sybil resistance good enough for a demo with its limits written plainly, a page with the current state and a log of every mint and burn, and a 60-day simulation of community behaviour that picks the parameters.

This file is the spec in words. The contract (`contract/`, API in `contract/README.md`) implements it, the simulation (`sim/bonfire_sim.py`, `docs/SIMULATION.md`) models it with the same integer arithmetic and picked the launch values, and a golden test checks that both settle the same nights to the last base unit.

## Words

| Word | Meaning |
|---|---|
| EMBER | the NEP-141 token |
| night | one round of the ritual; its length `night_ms` is a launch parameter (launch: one day; testnet demo: five minutes) |
| window | a night is cut into `pool_windows` equal windows (launch: four windows of six hours) |
| wood | EMBER a holder throws on tonight's pile; it is locked until the night ends |
| target | the wood the pile needs tonight to catch |
| LIT | the pile reached the target when the night ended |
| SMOKED | the pile fell short |
| COLD | nobody threw any wood |
| firestarter | the first account to throw wood on a night |
| the last log | the throw that made the pile reach the target |
| hearth | the contract's own EMBER treasury; it hands out kindling to newcomers and burns on smoky nights |
| collect | crediting a thrower with what a settled night owes it |
| streak | lit nights in a row; the longest streak and the tallest fire are kept as records |

## One night

1. **Throwing.** During the night any holder may throw wood: `amount` EMBER moves from their balance onto the pile. A holder may throw several times. Wood cannot be taken back before the night ends. A throw smaller than `min_throw` is refused, and every throw names tonight's number, so a delayed transaction cannot land on the next night.

2. **Weight: by place in the pile, pooled by window.** Each night is cut into `pool_windows` equal windows. All wood that lands in the same window counts as landing together. Wood below the target is weighted by its place in the pile: the factor falls linearly from `early_max` on an empty pile to 1.0 at the target. A window's wood covers the slice of the pile from the wood of all earlier windows upward, and shares that slice's weight in proportion to the wood each thrower put in. Wood above the target counts with `late_lit`.

   With `pile` the wood of all earlier windows, `below` the window's wood up to the target and `above` the rest, the window weighs

   ```
   below * (early_max - (early_max - 1) * (2 * pile + below) / (2 * target)) + above * late_lit
   ```

   and each thrower gets the window's weight times its wood in the window over the window's wood, rounded down. The first wood on a cold pile earns the most and the wood that closes the gap the least. Inside a window the order of throws does not matter, so nobody owns the bottom of the pile by being first in a block. One throw that covers the whole target earns the average factor, `(early_max + 1) / 2`.

3. **Settling.** When the night is over, anyone may call `settle()` (the page does it on its own, and every throw, kindling claim and collection does it first). Nights nobody touched settle in a batch, up to `max_catchup` per call. Settling records only the night's totals; it does not pay anyone.

4. **LIT** (`pile >= target`):
   - every thrower is owed all its wood back;
   - the contract mints `mint = target * mint_pct`; `hearth_cut` of it goes to the hearth, and the rest is owed to tonight's throwers by weight;
   - the target grows by `grow_pct`; the streak grows; records update.

5. **SMOKED** (`0 < pile < target`):
   - `smoke_pct` of the pile burns, and the rest is owed back to the throwers pro rata;
   - the hearth burns `hearth_burn_pct` of its balance, but never more than one night's mint (`target * mint_pct`), so a failed night costs the common pot without outweighing what a lit night brings;
   - the target shrinks by `shrink_pct`; the streak resets.

6. **COLD** (no wood at all): nothing burns. The target shrinks by `shrink_pct` and the streak resets, so the fire does not idle at a target nobody reaches.

7. **The target's bounds.** After the rule above, the target is capped at `target_cap` of the free supply (supply minus hearth minus pile): a large supply cannot be lured into an ever larger fire, and one lit night mints at most `target_cap * mint_pct` of the free supply. Then the target never falls below `target_min`. When the two conflict, `target_min` wins.

## Pull payments

A settled night only records what it owes. Each thrower is credited when it next throws, transfers, claims or acts through the browser, or when anyone calls `collect(account)` for it. `ft_balance_of` already counts the credit, so wallets show the right balance before anyone collects. A holder can only throw on the night that is burning, so it is owed for at most one night at a time, and that credit is collected before its next throw. The night's record goes away when its last thrower collects.

Settling therefore costs the same whether a night had five throwers or five thousand, and there is no cap on throwers.

Every division rounds down, against the thrower. The rounding dust of the shares and returns (a few base units a night) goes to the hearth when the night's last thrower collects; until then it is part of what the night owes.

## The hearth (treasury with rules)

- At launch the hearth holds `hearth_genesis` EMBER. The rest of the genesis supply goes to the founding holders listed in the init call (on testnet: the five demo bots, implicit accounts that the page and the README label as bots).
- Kindling: an account that has never held EMBER may claim `kindling` EMBER from the hearth once. At most `kindling_per_night` claims are paid per night, first come first served; when the hearth holds less than `kindling`, kindling stops. A kindling farm can therefore take at most `kindling * kindling_per_night` a night: 2,500 EMBER at launch, about 104 an hour.
- Refill: `hearth_cut` of every lit night's mint, and the rounding dust.
- Drain: `hearth_burn_pct` of the hearth on every smoky night, at most one night's mint. Cold nights burn nothing.
- Nobody can withdraw from the hearth. It has no owner.

## Records, names and the coin's face

- Records: longest streak, tallest fire (largest target lit), total minted, total burned, and the number of lit, smoked and cold nights.
- Every night has its firestarter, and every lit night its last log, in the events and on the page.
- The token's icon (`ft_metadata().icon`) is an SVG the contract draws from its state. At the top it says how the last night ended: `LIT ×12` (the streak, in letters that grow with it), `SMOKED` or `COLD`. In the middle burns the last night's fire, tall when lit, low under grey smoke when smoked, cold embers when cold. Along the bottom the last seven nights stand as small flames, smoke puffs or empty rings. A wallet or explorer that displays `ft_metadata().icon` shows the fire; many cache metadata, so they may show an older night.

## What the rules contain, and what they do not

- **Splitting earns nothing.** A night's weights depend only on each window's total wood, and each thrower gets its share of its windows pro rata. Ten accounts throwing X/10 in a window end the night with what one account throwing X ends it with, less at most one base unit each, and nobody else's result changes at all.
- **The solo lighter is contained, not removed.** A holder whose balance covers the target can throw it all at the first moment of the night, and from then on the fire cannot smoke. No rule that sees only wood, time and place in the pile can tell such a holder from a community that throws early, because the holder can split its throw over accounts. Pooling changes who shares the bottom of the pile: everyone who throws in the first window shares it with the solo lighter, pro rata. In the simulation's solo-lighter scenario (a holder with 12 % of supply) it takes about 67 % of the mint instead of 93 %, and the community's early wood earns 1.9 % per EMBER and night instead of 0.3 %. The solo lighter still earns well and without risk; its share depends on how much the community throws in the first window. And it compounds: see [Before a mainnet launch](#before-a-mainnet-launch).
- **The exact-gap sniper is close to early wood.** Inside a window every unit gets the window's average factor, so wood that closes the gap in the last window shares that window's average instead of being the top of the pile alone. A sniper who throws exactly the gap earns within about 1.3x of early wood per EMBER. With `late_lit` 0.25, the model's sniper also warms a safe fire, and its wood as a whole earns 2-4x less than early wood.
- **Accounts matter only for kindling.** Implicit accounts cost nothing, so "once per account" alone stops nobody. What bounds a farmer is `kindling_per_night` claims a night from a finite hearth: the farm mints nothing and drains at a fixed, published rate, but while it wins every claim, newcomers get none. `max_accounts` caps how many accounts the contract pays storage for.

## Where Bonfire departs from the prompt, and why

The prompt's example is a streak coin: holders check in once a day, a met target mints a little to everyone who checked in, a miss burns a slice of the treasury and resets the streak, and the longest streak is the high score. Bonfire keeps that shape and changes five things.

| The prompt | Bonfire | Why, and what it costs |
|---|---|---|
| Holders check in; the target counts check-ins. | Holders throw EMBER; the target counts EMBER thrown, not accounts. | Accounts are free on NEAR (an implicit account is a key pair), so a target in heads is met by one script with many keys. Counting wood makes splitting useless. The cost: one holder with enough EMBER can be the whole "community" (the solo lighter above, and [Before a mainnet launch](#before-a-mainnet-launch)). |
| Everyone who checked in gets a small mint. | The mint is shared by weight: wood on the cold pile counts up to x4, wood above the target x0.25. | An equal mint per head would pay for splitting. The weight pays early wood for the smoke risk it takes. |
| A miss burns a slice of the treasury. | A SMOKED night burns 3 % of the pile and a capped slice of the hearth (0.25 %, at most one night's mint). A COLD night, with no wood at all, burns nothing. | Burning the hearth on every missed night, empty ones included, outweighed the mint in a small community and let free riders gain share (docs/SIMULATION.md, finding 8). The cost: the holders who showed up pay for a miss, and those who stayed away pay nothing. |
| Every day. | A night is `night_ms`: one day at the launch values, five minutes on testnet. | Five minutes on testnet so a visitor sees a whole night, dawn included. |
| The longest streak is printed like a high score. | The page shows the current streak on the *Tonight* card and the longest under *Records*. The coin's icon shows the current streak. | The icon has room for one number, and the current streak is the one at stake tonight. |

## No owner

- Launch parameters are init arguments, stored once and shown by `config()`. There is no method that changes them.
- After deployment every access key of the contract account is deleted. The page and the README show how to check this with one RPC call, and the build checks that the wasm exports no method beyond the ritual, NEP-141, NEP-145, NEP-148 and the views.

## Playing without a wallet

As in Lantern Row (same author, independent project): the browser makes an ed25519 key, the holder is the implicit account derived from that key (64 hex characters), and actions are signed by that key and relayed through public function-call keys that may only call `act`, `settle` and `collect`. The contract checks the signature and a nonce. Balances are ordinary NEP-141 balances of those implicit accounts, so `ft_balance_of` and `ft_transfer` work as usual. Holders with a NEAR wallet call `throw_wood(amount, night)`, or `ft_transfer_call` to the contract with msg `"throw:<night>"`.

**Why not NEP-366 meta-transactions.** A NEP-366 delegate action is checked against an access key of the sender's account on chain, so every visitor would first need an account created for its key, paid by a sponsor. With `act` a visitor is only a NEP-141 balance inside the contract, which checks the ed25519 signature itself, and the relay needs no account per player. The price: a signing scheme of its own that wallets do not know, and a key that lives in one browser's local storage.

**Without the relay.** The relay is a convenience, not part of the rules. Any NEAR account can play with its own key and gas: `claim_kindling`, then `throw_wood` with 1 yoctoNEAR, and `collect` (commands in [contract/README.md](contract/README.md#playing-from-a-near-account-without-the-relay)). If the relay's keys run dry, the contract still takes every call from an account that pays its own gas.

## Log

- NEP-297 events: the standard `ft_mint`, `ft_burn` and `ft_transfer`, plus `bonfire` events `throw`, `lit`, `smoked`, `cold` and `kindling`. A throw is a transfer to the contract, a lit night mints to the contract, smoke burns from it, and a collection is a transfer from it to the thrower, so replaying the events gives every balance.
- `night(n)`: the night's totals, windows, firestarter and last log for the last `log_keep` nights; each thrower's part is in its `throw` events and its collection.
- `history(from, limit)`: one compact row per night (night, target, pile, outcome, minted, burned, supply after), for the supply chart on the page.

## Launch parameters

Picked by the simulation; `sim/params.json` holds them in the contract's field names and units, `docs/SIMULATION.md` gives the reasons. The testnet column is what `config()` of `bonfire-coin.testnet` returns.

| Parameter | Launch | Testnet (`config()`) |
|---|---|---|
| `night_ms` | 86,400,000 (one day) | 300,000 (five minutes) |
| genesis supply | 1,000,000 EMBER | 3,100,000 EMBER ¹ |
| `hearth_genesis` | 400,000 | 3,000,000 ¹ |
| `target_start` | 20,000 | 400 |
| `target_min` | 5,000 | 100 |
| `grow_pct` (`grow_bp`) | 7 % | 7 % |
| `shrink_pct` (`shrink_bp`) | 10 % | 10 % |
| `mint_pct` (`mint_bp`) | 4 % of the target | 4 % |
| `hearth_cut` (`hearth_cut_bp`) | 10 % of the mint | 10 % |
| `smoke_pct` (`smoke_bp`) | 3 % of the pile | 3 % |
| `hearth_burn_pct` (`hearth_burn_bp`) | 0.25 % of the hearth, at most one night's mint | 0.25 % |
| `early_max` (`early_max_bp`) | 4.0 | 4.0 |
| `late_lit` (`late_lit_bp`) | 0.25 | 0.25 |
| `pool_windows` | 4 | 4 |
| `target_cap` (`target_cap_bp`) | 25 % of the free supply | 25 % |
| `min_throw` | 50 EMBER | 1 EMBER |
| `kindling` | 250 EMBER | 200 EMBER |
| `kindling_per_night` | 10 | 4 ¹ |
| `max_catchup` | 30 nights | 30 nights |
| `log_keep` | 14 nights | 48 nights |
| `max_accounts` | 1,664 | 4,505 |
| `history_keep` | 1,024 nights | 4,096 nights |

¹ The `testnet` block of `sim/params.json` has `hearth_genesis` 900,000 and `kindling_per_night` 1. The launch changed both ([docs/testnet-launch.md](docs/testnet-launch.md); `scripts/judge-checks.sh` check 4 compares them with the chain): 4 claims a night, so a second visitor on the same night need not wait for the next one, and a 3,000,000 EMBER hearth, so that a script winning every claim cannot empty it before 2026-11-19. The founders' 100,000 EMBER (the five demo bots) are unchanged. So on testnet the hearth holds about 97 % of the supply, against 40 % at the launch values. EMBER outside the hearth (balances, credits owed and tonight's pile, `supply - hearth` in `state()`) was 100,000 at genesis and 102,441 at night 310 (2026-11-07 11:40 UTC), +2.4 %; 600 of that came from the hearth as three kindling claims, and the five bots held 101,468 of it.

## Before a mainnet launch

The testnet contract is locked and keeps these rules. A mainnet launch would need a new contract, and first an answer to one problem that the 60-night criteria did not catch.

**Showing up compounds.** A lit night pays its throwers in new EMBER, by weight. A holder that throws safely and often gains share from everyone who throws less, and its larger balance earns more the next night. Over 60 nights this stays modest; over a year it does not. The launch values over 365 nights, medians over 8 seeds ([docs/SIMULATION.md](docs/SIMULATION.md#a-year-with-the-launch-values-what-compounds)):

- The opening-bell solo lighter starts with 12.0 % of supply. It holds 22.9 % after 60 nights, 50.3 % after 180 and 65.3 % after 365, and loses no wood to smoke in any seed. Its share of the throwers' mint rises from 67 % to 76 %. Supply ends at 17.2x genesis.
- When everyone throws everything, every night is lit, the streak is the whole year, and supply ends at 17.9x.
- The healthy community ends at 2.3x. A founding holder who never throws keeps 43 % of its share of supply.
- In the whale-dominated community the largest holder, a whale, goes from 21.0 % to 30.9 % of supply, although the model's whale throws only part of its balance, on 60 % of nights.

**What the target cap bounds, and what it does not.** The cap keeps the target at or below 25 % of the free supply. So a lit night mints at most 1 % of the free supply (`mint_pct` is 4 % of the target), and 0.9 % goes to the throwers. That bounds the rate, not the level: lit at the cap every night, the free supply grows by up to 1.009^365, about 26x, in a year, plus kindling. It bounds no holder's share. And it helps a large holder: once a holder owns at least 25 % of the free supply, the cap keeps every target within its reach, so it can light every night alone. In the whale-dominated scenario the largest whale holds about a third of the free supply from the start. On testnet `demo-bot-early-a` holds about 40 % of the EMBER outside the hearth (40,686 of 102,441 at night 310); it does not light alone only because its script throws about 200 a night.

**Candidates to simulate.** None is tested yet. Each must keep splitting useless, so each may look at windows and wood, never at accounts.

- A lower `target_cap`. At 10 % the cap binds in the healthy community too, which is then lit every night (docs/SIMULATION.md, finding 9): a lower ceiling, paid for with the cliff-hanger.
- A cap against a fixed amount, for example a share of the genesis free supply, so a lit night at the cap mints a fixed amount and supply grows at most linearly. The target then stops following a community that grows beyond that size.
- A mint that shrinks when one window holds most of the wood below the target, so a solo lighter's window earns less unless others join it. It also costs a community that throws early together.
- Judging every candidate over 365 nights, with criteria on supply growth and on the largest holder's share, not only over the 60 nights the track asks for.
