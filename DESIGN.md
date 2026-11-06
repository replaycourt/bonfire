# Bonfire: design (working draft)

A memecoin whose holders build a bonfire together every night. Bring enough wood and the fire catches: everyone who brought wood gets their wood back plus new EMBER. Fall short and part of the wood goes up in smoke. Every rule lives in one NEAR contract with no access keys, so nobody can change it once launched.

Track: Memecoins With Mechanics (`memecoins`). The prompt asks for supply that reacts to the community, treasuries with rules, on-chain rituals and challenges, an NEP-141 token with the mechanic in the contract, every parameter fixed at launch and readable by anyone, sybil resistance good enough for a demo with its limits written plainly, a page with the current state and a log of every mint and burn, and a 60-day simulation of community behaviour that picks the parameters.

## Words

| Word | Meaning |
|---|---|
| EMBER | the NEP-141 token |
| night | one round of the ritual; its length `night_ms` is a launch parameter (simulation: one day; testnet demo: a few minutes) |
| wood | EMBER a holder throws on tonight's pile; it is locked until the night ends |
| target | the wood the pile needs tonight to catch |
| lit | the pile reached the target when the night ended |
| smoke | the pile fell short |
| hearth | the contract's own EMBER treasury; it hands out kindling to newcomers and pays part of the smoke |
| streak | lit nights in a row; the longest streak and the tallest fire are kept as records |

## One night

1. During the night any holder may throw wood: `throw(amount)` moves `amount` EMBER from their balance onto the pile. A holder may throw several times. Wood cannot be taken back before the night ends.
2. Each throw gets a weight: `weight = amount * early(t)`, where `t` is the fraction of the night that has passed when the wood lands. `early(t)` falls linearly from `early_max` (at t = 0) to 1.0 (at t = 1). Wood thrown after the pile already reached the target counts with weight `amount * late_lit` (late_lit < 1). Early wood carries the risk of a smoky night, so it earns more; wood thrown onto a fire that is already safe earns least.
3. When the night is over, anyone may call `settle()` (the page does it on its own). Nights nobody touched settle in a batch, up to `max_catchup` at a time.
4. If `pile >= target` (**lit**):
   - every thrower gets all their wood back;
   - the contract mints `mint = mint_pct * target` new EMBER; `hearth_cut` of it goes to the hearth, the rest is shared among tonight's throwers by weight;
   - `target_next = target * (1 + grow_pct)`; streak + 1; records updated.
5. If `pile < target` (**smoke**):
   - `smoke_pct` of the pile burns; the rest goes back to the throwers pro rata;
   - the hearth burns `hearth_burn_pct` of its own balance too, so a failed night costs the common pot;
   - `target_next = max(target_min, target * (1 - shrink_pct))`; streak resets to 0.
6. A night with no wood at all is smoke with nothing to burn from the pile (the hearth still burns its slice). This keeps the fire from idling forever at a high target.

## The hearth (treasury with rules)

- At launch the hearth holds `hearth_genesis` EMBER. The rest of the genesis supply goes to the founding holders listed in the init call (for the testnet demo: the demo bots, labelled as bots).
- Kindling: an account that has never held EMBER may call `claim_kindling()` once and gets `kindling` EMBER from the hearth. At most `kindling_per_night` claims are paid per night, first come first served; when the hearth runs dry, kindling stops.
- Refill: `hearth_cut` of every lit night's mint goes to the hearth.
- Drain: `hearth_burn_pct` of the hearth burns on every smoky night.
- Nobody can withdraw from the hearth. It has no owner.

## Records and the coin's face

- `records()`: longest streak, tallest lit fire (largest target lit), total minted, total burned.
- The token's icon (`ft_metadata().icon`) is an SVG the contract draws from its state: the fire's height reflects the last night's pile against its target, the streak is written under it, and smoke shows as grey. Every wallet that shows the token shows tonight's fire.

## Sybil resistance

- Every reward is proportional to EMBER thrown (and when it was thrown). Splitting one balance across a hundred accounts throws the same wood with the same timing and earns exactly the same, so extra accounts gain nothing in the ritual.
- The one place where accounts matter is kindling. It is capped per night (`kindling_per_night`), paid only to accounts that never held EMBER, and drawn from a finite hearth, so a farmer can at most drain the hearth slowly; that slows newcomers but mints nothing new. This limit goes into the README plainly.

## No owner

- Launch parameters are init arguments, stored once and shown by `config()`. There is no method that changes them.
- After deployment every access key of the contract account is deleted. The page and the README show how to check this with one RPC call.

## Playing without a wallet

As in Lantern Row (same author, independent project): the browser makes an ed25519 key, the holder is the implicit account derived from that key (64 hex characters), and actions are signed by that key and relayed through public function-call keys that may only call `act` and `settle`. The contract checks the signature and a nonce. Balances are ordinary NEP-141 balances of those implicit accounts, so `ft_balance_of` and `ft_transfer` work as usual. Holders with a NEAR wallet can call `ft_transfer` and `ft_transfer_call` directly; throwing from a wallet works through `ft_transfer_call` to the contract with msg `"throw"`.

## Log

- NEP-297 events: the standard `ft_mint`, `ft_burn`, `ft_transfer`, plus `bonfire` events for `throw`, `lit`, `smoke`, `kindling`.
- `night(n)`: pile, target, outcome, minted, burned, throwers and weights for the last `log_keep` nights.
- `history(from, limit)`: one compact row per night since launch (night, target, pile, outcome, supply after), for the supply chart on the page.

## Launch parameters (first guesses; the simulation picks the final values)

| Parameter | First guess |
|---|---|
| night_ms | 86,400,000 in the simulation; 300,000 (5 min) on testnet |
| genesis supply | 1,000,000 EMBER |
| hearth_genesis | 400,000 |
| target_start | 20,000 |
| target_min | 5,000 |
| grow_pct | 5 % |
| shrink_pct | 10 % |
| mint_pct | 5 % of target |
| hearth_cut | 20 % of the mint |
| smoke_pct | 10 % of the pile |
| hearth_burn_pct | 1 % of the hearth |
| early_max | 1.5 |
| late_lit | 0.5 |
| kindling | 500 EMBER |
| kindling_per_night | 20 |
| max_catchup | 30 nights |
| log_keep | 14 nights |
