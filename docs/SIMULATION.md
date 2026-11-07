# Bonfire: 60 nights of community behaviour

The track asks to simulate 60 days of community behaviour first, show supply over time under a few scenarios, and then pick the parameters. This document is that simulation. It models the contract's rules, runs nine scenarios over 60 nights each (six communities, two sybil attacks on the healthy one, and a stress case), sweeps the main knobs, and picks the launch parameters in `sim/params.json`. Four of the scenarios also run for 365 nights, to show what compounds.

The rules changed twice after DESIGN.md. A first pass ran DESIGN.md as written and found flaws. An adversarial review then found more, and the rules changed:

- wood is weighted by where it lands in the pile, not by the clock;
- throwers are paid lazily, so there is no cap on throwers per night;
- empty nights no longer burn the hearth, and a smoky night's hearth burn is capped;
- the target is capped relative to the free supply;
- `min_throw` refuses dust throws.

That left one problem: a holder who can cover the whole target alone at the opening bell takes the whole mint. Three fixes were tested against it: "kindlers and warmers", pooled windows, and pooling only the opening window. Pooled windows passed every criterion and is the launch rule: all wood that lands in the same quarter of the night counts as landing together. Kindlers and warmers alone did not pass. Pooling costs part of early wood's edge over a sniper who closes the gap exactly (finding 3).

**DESIGN.md must change one rule:** how wood is weighted. The section "What DESIGN.md must change" below states it exactly. Everything else in DESIGN.md's ritual stays, with the revisions listed above.

Tables between `generated` markers are written by the script on every run. The prose around them gives rounded numbers from the same run.

## Rerun it

```
python3 sim/bonfire_sim.py
```

This needs Python 3.8 or later and only the standard library. It runs everything: the scenarios under every rule set, the sweep, the sensitivity check and the testnet variant. It writes the charts in `docs/sim/` and the generated blocks in this file. It first runs the sweep and writes its pick to `sim/params.json`, then runs everything else with that pick, so one run is always consistent. It takes about 20 minutes on four idle cores, most of it the sweep. `python3 sim/bonfire_sim.py scenarios` takes about a minute and redoes the scenarios and the charts. `sweep` reruns only the sweep and the sensitivity check (`--write-params` also writes the pick). Two commands are not part of the default run and leave every other table alone: `longrun` writes the 365-night table (about 6 minutes; `--nights N` for another length), and `deployed` the testnet run with the two values changed at the testnet launch (about 30 seconds). Every run is deterministic: the same seeds give the same numbers to the last unit.

## Method

**The contract model.** `Fire` in `sim/bonfire_sim.py` is a state machine with the contract's arithmetic:

- Amounts are integers in yoctoEMBER (18 decimals). Rates and weight factors are basis points.
- Every division rounds down. Rounding dust from shares and refunds goes to the hearth, so nothing appears or vanishes.
- After every night the model asserts four things:
  - `supply = balances + pile + hearth`, to the last unit;
  - `supply = genesis + minted - burned`;
  - no balance is negative;
  - the target never falls below `target_min`.

  An invariant break stops the run. No run in this document broke one.

**A night.** Each holder first draws its intention for the night from its own random stream: whether it plays, when in the night it acts, and how much it would throw. All actions are then played in time order, and each one sees the fire as it is at that moment: the pile, the target and the streak. A throw below `min_throw` is refused. At the end of the night the fire settles:

- **Lit:** all wood goes back, and `mint_pct` of the target is minted. `hearth_cut` of the mint goes to the hearth; the rest is shared by weight. The target grows by `grow_pct`.
- **Smoke:** `smoke_pct` of the pile burns and the rest goes back pro rata. The hearth burns `hearth_burn_pct` of its balance, but at most one night's mint (`target * mint_pct`). The target shrinks by `shrink_pct`.
- **No wood at all:** the target shrinks and the streak resets; nothing burns.
- **The target** never exceeds `target_cap` of the free supply (supply minus hearth minus pile) and never falls below `target_min`.

Every night is settled on time, so the batch catch-up (`max_catchup`) does not change any result. The contract pays throwers lazily, so the model has no limit on throwers per night, and neither has the contract.

**Weight: by pile position.** The part of a throw below the target is weighted by where it lands in the pile. The factor falls linearly from `early_max` on an empty pile to 1.0 at the target, integrated over the slice the throw covers:

```
weight = below * (early_max - (early_max - 1) * (2 * pile + below) / (2 * target)) + above * late_lit
```

Here `pile` is the pile before the throw, `below` the part of the throw up to the target, and `above` the rest. The first wood on a cold pile earns the most. The wood that closes the gap earns the least. One throw that covers the whole target earns the average factor, `(early_max + 1) / 2`. Because the weight is an integral over the pile, it adds up the same however the wood is split between accounts.

**Pooled windows (the launch rule).** The night is cut into `pool_windows` equal windows; at launch there are 4, six hours each. All wood that lands in one window counts as landing together. The window's wood covers a slice of the pile, from the pile at the window's start to that plus the window's wood, and shares that slice's weight pro rata:

```
window weight = slice weight of the window's wood below the target + its wood above the target * late_lit
each throw's weight = window weight * its wood / the window's wood
```

Inside a window, the order of throws does not matter, so nobody owns the bottom of the pile by being first in a block. Across windows, earlier wood still lands lower and earns more. The weight still adds up the same however the wood is split between accounts.

**Rule sets compared.** Seven rule sets run on the same communities and seeds:

| Rule set | Weight of wood below the target | Crossing throw | Hearth burn | Target cap |
|---|---|---|---|---|
| DESIGN.md as written | by the clock: `early(t)` falls from `early_max` at the start of the night to 1.0 at its end | counts all its wood at `early(t)` | every smoky or empty night, uncapped | none |
| clock weight | by the clock | split at the target | revised | revised |
| pile-position weight | by pile position, as above | split at the target | revised | revised |
| **pooled windows (launch)** | by pile position; all wood in the same window counts as landing together, pro rata | split at the target | revised | revised |
| kindlers and warmers (tested, not adopted) | below the target by pile position; above it at factor 1.0. A lit night pays every thrower `yield_bp * own weight`, scaled down pro rata only when the night's mint would exceed `mint_cap_bp * target` | split at the target | revised, capped at `mint_cap_bp * target` | revised |
| warmers with pooled windows (tested, not adopted) | both of the above | split at the target | as kindlers and warmers | revised |
| pooled opening window (tested, not adopted) | by pile position; only the first window's wood is pooled, later wood keeps its exact place | split at the target | revised | revised |

The headline results and the parameter pick use pooled windows. The other rule sets appear where they differ. The two warmer rule sets run at `yield_bp` 100 (1 %) and `mint_cap_bp` 400, the best pair of a grid of yield 0.25-1.5 % and cap 3-5 %; the rule comparison below gives the grid's result.

**Seeds and measures.** Each scenario runs over 8 seeds and the tables show medians. Every holder has its own seeded random stream, so adding or removing one holder does not change what the others do. That is what makes the splitter comparison exact. The measures:

- **net reward per EMBER thrown:** the EMBER minted to a behaviour minus its wood burned, divided by all the wood it threw over the 60 nights. It is the average gain of one EMBER on one night's pile.
- **free riders' share:** the founding free riders' share of total supply, at night 60 against genesis.
- **riskless share:** the part of the throwers' mint that went to wood thrown onto a fire that was already safe.

## Behaviour models

| Behaviour | Plays on | Acts at | Throws | Condition |
|---|---|---|---|---|
| loyal | 90 % of nights | the first quarter of the night | 20-50 % of its balance | none |
| fair-weather | 85 % of nights | between 35 % and 85 % of the night | 15-40 % of its balance | only if the streak is at least 2 or the pile is at 60 % of the target |
| sniper | 90 % of nights | the last tenth (90-99.5 %) | exactly the gap when `late_lit` is 0, otherwise 30-60 % of its balance | only if its throw alone makes the fire safe, with the pile already at 80 % of the target, or onto a fire that is already safe while `late_lit` > 0 |
| whale | 60 % of nights | between 5 % and 60 % of the night | 10-30 % of a large balance | none |
| whale that snipes | 80 % of nights | the last 5 % | 20-40 % of a large balance in one throw | as the sniper, from 60 % of the target |
| opening-bell solo lighter | every night | the first moment of the night, before anyone else | exactly the target | only if its balance covers the target |
| all in (stress case) | every night | a random moment of the night | its whole balance | none |
| free rider | never | | | |
| newcomer | from the night after it arrives | | as its drawn behaviour, with its kindling as balance | arrives at a random moment (Poisson, 4 a night in most scenarios), claims kindling, and draws a behaviour from the scenario's mix; it leaves if no kindling is left that night |
| kindling farm | every night | the first moment of the night | its farmed balance, played as loyal | a bot claims every kindling slot with fresh accounts and forwards the EMBER to one account |
| splitter | as loyal or sniper | | the same wood at the same moment, spread over 64 accounts in proportion to their balances | decides once for all its accounts |

The sniper is the strongest version of the behaviour the model can express. It never risks smoke. It sees the pile exactly, throws only when its throw makes the fire safe or onto a fire that is already safe, and sizes the throw for the rule in force. Its results are therefore an upper bound for sniping.

Founding balances are lognormal (sigma 0.8) within each group. Each group's total is fixed by the scenario. The founders hold genesis minus `hearth_genesis`.

## Scenarios

| Scenario | Founding holders (count, share of the founders' EMBER) | Newcomers a night and their behaviours |
|---|---|---|
| Healthy community | 60 loyal (30 %), 80 fair-weather (25 %), 15 snipers (7 %), 100 free riders (23 %), 2 whales (15 %) | 4: 35 % loyal, 35 % fair-weather, 10 % sniper, 20 % free rider |
| Fading community | as healthy | as healthy; activity and arrivals fall by exp(-night / 20), to 5 % at night 60 |
| Whale-dominated | 20 loyal (6 %), 30 fair-weather (6 %), 5 snipers (2 %), 40 free riders (6 %), 2 whales (50 %), 1 whale that snipes (30 %) | 2, mix as healthy |
| Sniper-heavy | 25 loyal (10 %), 35 fair-weather (12 %), 120 snipers (45 %), 60 free riders (23 %), 2 whales (10 %) | 4: 15 % loyal, 20 % fair-weather, 50 % sniper, 15 % free rider |
| Free-rider-heavy | 20 loyal (8 %), 25 fair-weather (8 %), 5 snipers (2 %), 250 free riders (75 %), 1 whale (7 %) | 4: 10 % loyal, 15 % fair-weather, 5 % sniper, 70 % free rider |
| Opening-bell solo lighter | the healthy community at 80 % of its holdings, plus one solo lighter with 20 % of the founders' EMBER (12 % of supply) | as healthy |
| Everyone throws everything (stress case) | 277 holders, all "all in", balances as the founders of the healthy community | 4, all "all in" |
| Sybil kindling farm | as healthy, plus a farm that wins every kindling slot every night | as healthy, but they only get kindling the farm left |
| Sybil splitter | as healthy; 3 % of the founders' EMBER belongs to one loyal holder split over 64 accounts | as healthy |

## Results with the launch parameters

![Total EMBER supply over 60 nights, by scenario](sim/supply.svg)

<!-- BEGIN generated:scenarios -->
| Scenario | Supply night 60 (x genesis, seed range) | Lit nights | Longest streak | Tallest fire (EMBER) | Hearth night 60 (EMBER) | Early (loyal) | Late (fair-weather) | Sniping: completing | Sniping: piling on | Free riders' share |
|---|---|---|---|---|---|---|---|---|---|---|
| Healthy community | 1.112 (1.109-1.117) | 80 % | 27 | 143,849 | 344,701 | +1.99 % | +0.25 % | +0.98 % | +0.37 % | -10.1 % |
| Fading community | 1.001 (0.998-1.002) | 51 % | 14 | 51,571 | 362,386 | +1.24 % | +0.22 % | +0.97 % | +0.32 % | -0.1 % |
| Whale-dominated | 1.068 (1.051-1.089) | 75 % | 13 | 96,143 | 365,230 | +2.05 % | +0.44 % | +0.69 % | +0.34 % | -6.4 % |
| Sniper-heavy | 1.043 (1.036-1.048) | 72 % | 15 | 65,520 | 331,343 | +1.62 % | +0.53 % | +0.41 % | +0.29 % | -4.1 % |
| Free-rider-heavy | 1.024 (1.020-1.029) | 68 % | 7 | 45,301 | 327,996 | +1.94 % | +0.49 % | +0.88 % | +0.44 % | -2.3 % |
| Opening-bell solo lighter | 1.271 (1.270-1.273) | 95 % | 31 | 224,411 | 364,397 | +1.91 % | +0.15 % | n/a | +0.32 % | -21.3 % |
| Everyone throws everything | 1.318 (1.316-1.319) | 100 % | 60 | 234,384 | 370,687 | n/a | n/a | n/a | n/a | n/a |
| Sybil kindling farm | 1.148 (1.134-1.158) | 83 % | 28 | 191,982 | 262,210 | +1.94 % | +0.10 % | +0.85 % | +0.34 % | -12.9 % |
| Sybil splitter | 1.112 (1.111-1.126) | 80 % | 27 | 150,916 | 344,649 | +1.99 % | +0.29 % | +0.92 % | +0.38 % | -10.1 % |

Medians over 8 seeds. Early, late and the two sniping columns: net reward per EMBER thrown (mint received minus wood burned, divided by wood thrown, over all 60 nights). Sniping is split into the throws that make the fire safe and the wood piled onto a fire that is already safe. The last column: the change in the founding free riders' share of total supply from genesis to night 60.
<!-- END generated:scenarios -->

- **Healthy community.** The fire is lit on four nights in five. The target needs about 30 nights to climb from 20,000 to what the community throws, then swings around it with streaks and smoky nights. Supply grows by 11 % in 60 nights, and free riders lose a tenth of their share.
- **Fading community.** It lights the fire while it still plays, then smokes. With no hearth burn on empty nights and a capped burn on smoky ones, its supply ends level with genesis.
- **Whale-dominated, sniper-heavy and free-rider-heavy communities.** They stay within 7 % of genesis.
- **Opening-bell solo lighter.** Supply grows by 27 %, and free riders lose a fifth of their share. The solo lighter takes two thirds of the mint, and the community's early wood still earns 1.9 % per EMBER (finding 1).
- **Everyone throws everything.** This stress case is the ceiling: the fire is lit every night, and supply grows by 32 % in 60 nights. The target cap keeps it there over 60 nights. Under DESIGN.md's rules, which have no target cap, the same stress case reaches 1.65x (criteria table). The cap limits each night's mint, not the level: over 365 nights the stress case reaches 17.9x ("A year with the launch values").

![Healthy community: target and pile per night](sim/target_pile.svg)

The chart shows one seed of the healthy community. While the target climbs, the pile overshoots it every night. Once the target reaches what the community throws, smoke appears, the target drops, and the next streak begins.

![Net reward per EMBER thrown, by behaviour and by when the wood landed](sim/reward_per_ember.svg)

Net reward per EMBER thrown, by when the wood landed. Launch parameters, medians over 8 seeds:

<!-- BEGIN generated:buckets -->
| Wood that landed ... | Healthy community | Sniper-heavy | Whale-dominated | Fading community |
|---|---|---|---|---|
| early (first third of the night) | +2.05 % | +1.69 % | +2.30 % | +1.14 % |
| middle third | +0.63 % | +1.06 % | +1.14 % | +0.40 % |
| last third, before the fire is safe | -0.89 % | -0.46 % | -0.38 % | -1.38 % |
| the throw that crosses the target, all of it | +1.45 % | +0.70 % | +1.38 % | +1.74 % |
| only the part of that throw that closes the gap | +1.52 % | +0.68 % | +1.74 % | +1.89 % |
| after the fire is already safe | +0.59 % | +0.30 % | +0.40 % | +0.60 % |
<!-- END generated:buckets -->

- **Wood in the first third of the night** earns 1.1-2.3 % per night of wood; **the middle third** earns 0.4-1.1 %.
- **Wood in the last third on a night that is not yet safe** loses: -1.4 % to -0.4 %. It carries the smoke risk and lands high on the pile.
- **The part of a throw that closes the gap** earns 0.7-1.9 %. It always lands on a lit night, but high on the pile.
- **Warming**, wood thrown onto a fire that is already safe, earns 0.3-0.6 % at `late_lit` 0.25: a little, without risk.

By behaviour, loyal holders earn 1.6-2.1 % per EMBER (1.2 % in the fading community). A sniper's completing throws earn 0.4-1.0 % and its warming 0.3-0.4 %. Early wood thus earns about twice what sniping earns in the healthy community and four times in the sniper-heavy one. That edge holds for a sniper who, like the model's, throws more than the gap to warm as well. A sniper who throws exactly the gap does better per EMBER (finding 3). In the fading community the gap-closing part earns more than early wood: most nights smoke, and that part always lands on a lit one.

### Splitting and the kindling farm

<!-- BEGIN generated:splitter -->
| Splitter behaviour | Rule | Balance night 60, 1 account (yoctoEMBER) | Same balance split over 64 accounts | Difference (yocto) | Difference / balance |
|---|---|---|---|---|---|
| loyal (throws early) | DESIGN.md as written | 26,313,558,712,665,755,422,639 | 26,181,571,283,980,715,107,595 | -131,987,428,685,040,315,044 | 5.02e-03 |
| loyal (throws early) | pile position, pooled windows | 26,514,957,480,078,382,209,819 | 26,514,957,480,078,382,207,786 | -2,033 | 7.67e-20 |
| sniper (completes the fire) | DESIGN.md as written | 19,421,574,725,082,268,736,788 | 19,171,878,534,328,462,880,165 | -249,696,190,753,805,856,623 | 1.29e-02 |
| sniper (completes the fire) | pile position, pooled windows | 19,752,054,301,829,561,347,905 | 19,752,054,301,829,561,346,470 | -1,435 | 7.27e-20 |
<!-- END generated:splitter -->

Under the launch rules, one balance spread over 64 accounts ends the 60 nights within about 2,000 yoctoEMBER of the same balance in one account. That is floor rounding, about 10^-19 of the balance: pooling is pro rata, so it adds up the same however the wood is split. Under DESIGN.md as written, the split balance earns 0.5-1.3 % less, because the sub-throws that land after the crossing one count at `late_lit`. The test sets `min_throw` to zero. `min_throw` refuses pieces smaller than itself, which only ever hurts the splitter.

<!-- BEGIN generated:farm -->
| Healthy community | without farm | with a farm that wins every slot |
|---|---|---|
| Kindling paid out over 60 nights (EMBER) | 61,125 | 150,000 |
| ... of which taken by the farm | 0 | 150,000 |
| Newcomers who got kindling | 244 of 245 | 0 of 245 |
| Hearth at night 60 (EMBER) | 344,701 | 262,210 |
| Supply at night 60 (x genesis) | 1.112 | 1.148 |

The farm's ceiling is kindling x kindling_per_night = 2,500 EMBER per night, 150,000 EMBER over 60 nights (38 % of hearth_genesis).
<!-- END generated:farm -->

The farm cannot mint anything. It can only move kindling from the hearth to itself, at most `kindling * kindling_per_night` a night. The real cost is to newcomers: while a bot wins every slot, no genuine newcomer gets kindling. The contract cannot tell a farm from a newcomer, and the README should say so.

## The rule sets side by side

The launch values under each rule set, same communities and seeds:

<!-- BEGIN generated:rules -->
| Launch values | DESIGN.md as written | clock weight, crossing split | pile position, pooled windows (4 windows) | pile-position weight | kindlers and warmers | warmers, pooled windows | pile position, pooled opening window |
|---|---|---|---|---|---|---|---|
| healthy: early (loyal), per EMBER | +1.90 % | +1.91 % | +1.99 % | +2.02 % | +1.07 % | +1.06 % | +1.99 % |
| healthy: sniping, completing throws, per EMBER | +1.38 % | +0.98 % | +0.98 % | +1.04 % | +0.92 % | +0.94 % | +1.02 % |
| sniper-heavy: early (loyal), per EMBER | +1.57 % | +1.58 % | +1.62 % | +1.63 % | +0.57 % | +0.56 % | +1.62 % |
| sniper-heavy: sniping, completing throws, per EMBER | +1.31 % | +0.99 % | +0.41 % | +1.05 % | +0.85 % | +0.81 % | +1.07 % |
| whale-dominated: whale's end-of-night throws, per EMBER | +1.20 % | +0.61 % | +0.75 % | +0.72 % | +0.99 % | +1.00 % | +0.72 % |
| whale-dominated: early (loyal), per EMBER | +1.36 % | +1.85 % | +2.05 % | +2.20 % | +1.19 % | +1.12 % | +2.05 % |
| solo lighter: its reward per EMBER | +3.45 % | +3.43 % | +2.43 % | +3.34 % | +2.20 % | +1.79 % | +2.43 % |
| solo lighter: its share of the throwers' mint | 96 % | 95 % | 67 % | 93 % | 75 % | 59 % | 67 % |
| solo lighter's community: early (loyal), per EMBER | -0.18 % | +0.21 % | +1.91 % | +0.32 % | +0.64 % | +1.06 % | +1.91 % |
| solo lighter's community: supply night 60 (x genesis) | 1.277 | 1.318 | 1.271 | 1.318 | 1.217 | 1.170 | 1.271 |
| healthy: lit nights | 80 % | 80 % | 80 % | 80 % | 78 % | 78 % | 80 % |
| healthy: supply night 60 (x genesis) | 1.112 | 1.112 | 1.112 | 1.112 | 1.064 | 1.064 | 1.112 |
<!-- END generated:rules -->

Read across the solo-lighter rows:

- **Without pooling**, the solo lighter takes 93-96 % of the throwers' mint, 3.3-3.5 % per EMBER per night without risk. The community's early wood earns at most 0.3 %. Weighting by pile position alone changes almost nothing here: when the solo lighter throws first and alone, its weight is the only weight below the target.
- **Kindlers and warmers** bring its share to 75 % and give the community 0.6 %. At these launch values they fail the early edge (1.2x in the healthy, 0.7x in the sniper-heavy community): warming is riskless, and sniping now pays like warming.
- **Pooled windows (launch)** bring its share to 67 % and give the community 1.9 % per EMBER. Early wood keeps an edge of 2.0x in the healthy and 4.0x in the sniper-heavy community, against the model's sniper.
- **Warmers with pooled windows** bring the share lowest, 59 %, but the community earns only 1.1 %, and at these launch values the early edge fails.
- **Pooling only the opening window** protects against the solo lighter just as well (67 %, community 1.9 %). Its edge against the model's sniper is narrower: 1.5x in the sniper-heavy community instead of 4.0x.

How the number of windows trades the early edge against the solo lighter's share (launch values otherwise):

<!-- BEGIN generated:windows -->
| pool_windows | window length | early edge, healthy | early edge, sniper-heavy | solo lighter's share of the mint | early wood beside a solo lighter |
|---|---|---|---|---|---|
| 2 | 720 minutes | 1.11 | 2.01 | 64 % | +1.69 % |
| 4 | 360 minutes | 2.02 | 3.95 | 67 % | +1.91 % |
| 8 | 180 minutes | 3.39 | 4.54 | 79 % | +1.38 % |
| 24 | 60 minutes | 2.70 | 3.33 | 88 % | +0.77 % |
<!-- END generated:windows -->

Two windows (12 hours each) make early and late wood within a night too equal: the early edge in the healthy community falls to 1.1x. Eight or 24 windows give the opening bell back to whoever throws first: the solo lighter's share rises to 79 % and 88 %. Four windows are the best of the four.

## What DESIGN.md must change

DESIGN.md, "One night", step 2, weights a throw by the clock: `weight = amount * early(t)`, with `late_lit` for wood thrown after the pile reached the target. Replace it with:

> **2. Each night is cut into `pool_windows` equal windows. All wood that lands in the same window counts as landing together. Wood below the target is weighted by its place in the pile: the factor falls linearly from `early_max` on an empty pile to 1.0 at the target. A window's wood covers the slice of the pile from the pile at the window's start upward, and shares that slice's weight in proportion to the wood each thrower put in. Wood above the target counts with `late_lit`.**

The window's weight is `below * (early_max - (early_max - 1) * (2 * pile + below) / (2 * target)) + above * late_lit`. Here `pile` is the pile at the window's start, `below` the window's wood up to the target, and `above` the rest. Each throw gets the window's weight times its share of the window's wood, rounded down.

The other revisions are already decided and listed at the top: lazy payment, no hearth burn on empty nights, the hearth-burn cap, the target cap, `min_throw`. DESIGN.md's parameter table also needs the new fields `pool_windows`, `target_cap_bp` and `min_throw`.

## What the simulation found

Findings 1-3 concern the opening-bell solo lighter and the cost of the fix, 4-9 the earlier flaws and their fixes, and 10-11 are notes for the contract.

**1. The opening-bell solo lighter: contained by pooled windows, not removed.** A holder whose balance covers the target throws exactly the target in the first moment of the night. From then on the fire cannot smoke. Without pooling, everyone who comes later lands on a safe pile, and the solo lighter takes almost the whole mint. No rule that sees only wood, time and pile position can tell such a holder from a community that throws early, because the holder can split its throw over accounts. What a rule can change is who shares the bottom of the pile. With pooled windows, everyone who throws in the first six hours shares it, pro rata.

In the solo-lighter scenario (a holder with 12 % of supply):

- the solo lighter takes 67 % of the mint instead of 93 %, earning 2.4 % per EMBER per night instead of 3.3 %;
- the community's early wood earns 1.9 % instead of 0.3 %.

The solo lighter still earns well and without risk. Its share now depends on how much the community throws in the first window. The README should say so.

**2. Kindlers and warmers: tested, not adopted.** In this rule, wood above the target earns at factor 1.0, and a lit night pays `yield_bp * weight`, capped at `mint_cap_bp * target`. It lowers the solo lighter's share (75 %) and pays the community a little (0.6 %). But no setting in a grid passed every criterion. The grid covered yield 0.25-1.5 %, cap 3-5 %, `smoke_pct` 1-2 % and `early_max` 4-5.

Two criteria pull against each other. Warming is riskless, so early wood needs a high `early_max` to beat it, and the sniper's completing throws, by 1.5x. A high `early_max` raises the solo lighter's average factor, `(early_max + 1) / 2`, and with it its share. The best settings each failed one criterion: either the early edge in the sniper-heavy community was 1.3x, or the solo lighter's share was 79 %.

Combined with pooled windows, it passed at `early_max` 5.0, `smoke_pct` 1 %, yield 1 % and cap 4 %. There the solo lighter took 61 % and the community's early wood earned 1.3 %, less than pooling alone pays. It also needs two rule changes instead of one. The meme survives without it: at `late_lit` 0.25, wood on a lit fire still earns a little (finding 6). If yield and mint cap are dropped, `mint_bp` stays in use: it is the fixed pie of a lit night, and it caps the hearth burn.

**3. What pooling costs: the gap-closer moves closer to early wood.** Inside a window every unit gets the window's average factor. So the wood that closes the gap in the last window is no longer the top of the pile alone; it shares that window's average. A sniper who throws exactly the gap earns about 1.3x less per EMBER than early wood. That shows in the `late_lit` 0 row of the sweep, where the sniper sizes its throw exactly. It is below the 1.5x the task asks for. At the launch `late_lit` of 0.25, the model's sniper also warms, and its wood as a whole earns 2-4x less than early wood. Without pooling, the exact gap-closer earns 1.9x less (rule comparison). Pooling only the opening window does not remove this cost: an exact gap-closer gets within 1.4x of early wood there too (quick test, `late_lit` 0, 2 seeds). The coordinator should weigh it against finding 1.

**4. A crossing throw counted all its wood as early (fixed).** Under DESIGN.md as written, the weight of a throw was set by the pile before it landed, so the throw that crossed the target counted entirely at `early(t)`, however far it overshot. One large throw earned more than the same wood split (splitter table). Early wood also earned less beside a whale's large end-of-night throws: 1.4 % per EMBER as written against 2.1 % at launch, in the whale-dominated community.

**5. With the first-guess rewards, early wood was a losing bet against sniping (fixed by parameters).** A sniper never risks smoke. It takes only the nights that light, and among them the ones with the least wood above the target. With `early_max` 1.5, `smoke_pct` 10 % and `late_lit` 0.5, early wood lost money in the sniper-heavy community while sniping earned, so waiting was the rational move for everyone. The launch values fix it with `early_max` 4.0, `smoke_pct` 3 % and `late_lit` 0.25. 4.0 is within the contract's limit of 5.0; 3.0 fails the early edge (sensitivity).

**6. `late_lit` 0.25: warmers earn a little.** Wood thrown onto a safe fire comes back the same night and cannot burn, so what it earns is paid for nothing. At 0.25 it takes about a fifth of the throwers' mint in the sniper-heavy community, and each EMBER of it earns 0.3-0.6 % against 1.6-2.1 % for early wood. With pooled windows, `late_lit` 0 fails the early edge (finding 3), while 0.1 and 0.25 pass it. The sweep picks 0.25, the passing value closest to the first guess. The meme holds: light the cold fire and earn most, warm your hands at a lit fire and earn a little.

**7. The kindling farm drains at a fixed, published rate.** It takes at most `kindling * kindling_per_night` a night.

- **Launch values:** 2,500 EMBER a night, about 104 an hour. That is 150,000 EMBER over 60 nights, 38 % of the hearth. The first guess (500 x 20) emptied the hearth by night 45.
- **Testnet:** the night is 5 minutes, so the rate per hour matters. 200 EMBER x 1 claim a night x 12 nights an hour is 2,400 EMBER an hour. A script that wins every claim needs at least 375 hours (15.6 days) to empty the 900,000 EMBER testnet hearth. The deployed contract has 4 claims a night and a 3,000,000 EMBER hearth: 9,600 EMBER an hour, at least 312.5 hours (13.0 days).

The farm's real cost is the newcomers it crowds out: while it wins every claim, nobody else gets kindling, judges included.

**8. The hearth burn was sized to the hearth, not to the fire (fixed).** A smoky night burned 1 % of a 400,000 EMBER hearth whether the community was large or small, and an empty night burned it too. In a small community the burns outweighed the mint, and free riders gained share: +1.2 % in the free-rider-heavy community with the first guess. The revised rules burn nothing on empty nights and cap a smoky night's hearth burn at one night's mint. With `hearth_burn_pct` 0.25 %, free riders lose 2.3 % of their share there.

**9. The target cap bounds the stress case over 60 nights, and the solo lighter lives with it.** When everyone throws everything, the target grows until the cap stops it at 25 % of the free supply. Supply then grows by 32 % in 60 nights, against 65 % without the cap. The cap bounds each night's mint (at most 1 % of the free supply), not the level: over 365 nights the stress case reaches 17.9x ("A year with the launch values"). The cap also keeps the target within a large holder's reach: in the solo-lighter scenario it set the target on 22 of 60 nights. 50 % would bind less against the solo lighter (supply 1.20x) but lets the stress case reach 1.52x. 10 % binds in the healthy community too, which is then lit every night.

**10. For the contract: pooled weights and 256-bit arithmetic.** For the open night the contract needs, per window, the pile at the window's start and the window's total wood. It also needs each holder's wood per window. A holder's weight is computed at payout, which lazy payment allows. Pooling is linear, so the weight can also be computed per holder without a list of throwers. In basis points the window's weight is `below * (early_max * 2 * target - (early_max - 10000) * (2 * pile + below)) / (2 * target) + above * late_lit`. Its intermediate product exceeds `u128` by far, so it needs the 256-bit `mul_div` the contract already has, rounded down. The share `shared * weight / total_weight` needs the same.

**11. `min_throw`.** DESIGN.md does not have it; the contract does. At 50 EMBER (1 % of `target_min`) it refuses dust throws. In the model it refuses only some newcomers' smallest throws. It can make splitting worse, never better.

## The long-run lit rate is set by two knobs

Once the target has found what the community throws, it moves up by `grow_pct` on lit nights and down by `shrink_pct` on smoky ones. It settles where these balance: a lit rate of

```
p* = ln(1 / (1 - shrink_pct)) / (ln(1 + grow_pct) + ln(1 / (1 - shrink_pct)))
```

This holds whatever the size of the community, because the target follows the community's capacity up and down. The launch values (7 %, 10 %) give p* = 61 %; the first guesses (5 %, 10 %) give 68 %. The testnet run, where the bots throw the same amounts for two weeks, lands on 61 %. Over 60 nights the healthy community lights more often than p*, because the target first climbs from `target_start` with nearly every night lit. A higher `target_start` shortens that climb and lowers the 60-night rate. The first tables of the sweep show both effects.

## A year with the launch values: what compounds

The track asks for 60 days, and the sweep judged the launch values on 60 nights. Sixty nights hide one effect: whoever throws safely and often gains share every lit night, and that compounds. This section runs four scenarios for 365 nights with the launch values and rules, unchanged. The first 60 nights of each run are the 60-night run of the same seed.

<!-- BEGIN generated:longrun -->
| Scenario | Night | Supply (x genesis, seed range) | Lit nights so far | Longest streak | Nights the cap set the target | Largest holder: share of supply | Largest holder: share of free supply | Founding free riders' share | Hearth (EMBER) |
|---|---|---|---|---|---|---|---|---|---|
| Healthy community | 60 | 1.112 (1.109-1.117) | 80 % | 27 | 0 | 6.3 % (whale) | 9.2 % | -10.1 % | 344,701 |
| Healthy community | 180 | 1.398 (1.372-1.401) | 69 % | 27 | 0 | 6.0 % (whale) | 7.3 % | -28.4 % | 249,206 |
| Healthy community | 365 | 2.317 (2.207-2.435) | 67 % | 27 | 11 | 5.7 % (whale) | 6.2 % | -56.8 % | 191,654 |
| Whale-dominated | 60 | 1.068 (1.051-1.089) | 75 % | 13 | 0 | 22.8 % (whale) | 34.7 % | -6.4 % | 365,230 |
| Whale-dominated | 180 | 1.267 (1.237-1.315) | 67 % | 13 | 0 | 27.1 % (whale) | 35.6 % | -21.0 % | 301,596 |
| Whale-dominated | 365 | 1.824 (1.734-1.966) | 65 % | 13 | 0 | 30.9 % (whale) | 35.8 % | -45.2 % | 245,119 |
| Opening-bell solo lighter | 60 | 1.271 (1.270-1.273) | 95 % | 31 | 21 | 22.9 % (the solo lighter) | 32.2 % | -21.3 % | 364,397 |
| Opening-bell solo lighter | 180 | 3.315 (3.299-3.339) | 98 % | 141 | 141 | 50.3 % (the solo lighter) | 58.2 % | -69.8 % | 450,732 |
| Opening-bell solo lighter | 365 | 17.160 (17.031-17.309) | 99 % | 326 | 326 | 65.3 % (the solo lighter) | 72.3 % | -94.2 % | 1,648,150 |
| Everyone throws everything | 60 | 1.318 (1.316-1.319) | 100 % | 60 | 28 | 1.9 % (all in) | 2.6 % | n/a | 370,687 |
| Everyone throws everything | 180 | 3.451 (3.429-3.472) | 100 % | 180 | 148 | 2.2 % (all in) | 2.5 % | n/a | 465,548 |
| Everyone throws everything | 365 | 17.860 (17.706-17.999) | 100 % | 365 | 333 | 2.3 % (all in) | 2.6 % | n/a | 1,717,419 |

Launch values and rules, 365 nights, medians over 8 seeds. Free supply is supply minus hearth (and pile). The largest holder is whoever holds most at that night; in brackets its behaviour in most seeds. At genesis the largest holder holds: healthy community 6.4 %, whale-dominated 21.0 %, opening-bell solo lighter 12.0 %, everyone throws everything 1.7 % of supply. Founding free riders' share: the change in their share of supply since genesis. The largest mint of any night in these runs was 1.00 % of the free supply when that night's target was set.

| Night | Solo lighter's balance (EMBER) | Its share of supply | Its share of free supply | Its share of the throwers' mint so far | Its wood lost to smoke, worst seed (EMBER) |
|---|---|---|---|---|---|
| 60 | 291,661 | 22.9 % | 32.2 % | 67.4 % | 0 |
| 180 | 1,666,416 | 50.3 % | 58.2 % | 73.9 % | 0 |
| 365 | 11,225,492 | 65.3 % | 72.3 % | 76.2 % | 0 |

The opening-bell solo lighter starts with 120,015 EMBER: 12.0 % of supply and 20.0 % of the free supply. Medians over 8 seeds.
<!-- END generated:longrun -->

- **The solo lighter takes over.** It starts with 12.0 % of supply and holds 22.9 % after 60 nights, 50.3 % after 180 and 65.3 % after 365. It never loses wood to smoke, because the fire is safe from the first moment of every night it plays, and its share of the throwers' mint rises from 67 % to 76 % as its balance outgrows the community's. The fire is lit on 99 % of nights, the longest streak is 326, supply ends at 17.2x, and the founding free riders keep 6 % of their share.
- **Everyone throws everything** lights every night for a year: the streak is 365 nights and supply ends at 17.9x. No holder gains much share (the largest goes from 1.7 % to 2.3 %), but no dawn is in doubt.
- **The healthy community** ends at 2.3x (2.2-2.4x over the seeds), lit on 67 % of nights. A founding holder who never throws keeps 43 % of its share. The largest holder stays a whale with about 6 %.
- **Whale-dominated:** supply ends at 1.8x, and the largest holder, a whale, goes from 21.0 % to 30.9 % of supply, although the model's whale throws only part of its balance, on 60 % of nights.

**What the target cap bounds, and what it does not.** The cap keeps the target at or below 25 % of the free supply. A lit night mints 4 % of the target, so at most 1 % of the free supply (the largest mint in these runs: 1.00 %), and 90 % of the mint goes to the throwers. That bounds the rate, not the level: lit at the cap every night, the free supply grows by up to 0.9 % a night, 1.009^365 = 26x in a year, plus kindling. In the stress case it grows 27x (from 600,000 to about 16.1 million EMBER). The cap bounds no holder's share. And it works for a large holder: a holder with at least 25 % of the free supply can cover every target alone. The solo lighter crosses that line before night 60; the largest whale of the whale-dominated community starts above it, with 35 % of the free supply.

The behaviour models stay fixed for a year here, so these runs show the rules' arithmetic, not what people would do: a real community could race the solo lighter for the first window, and a real whale could start lighting alone. The open problem and candidate fixes for a mainnet launch are in DESIGN.md, "Before a mainnet launch". The testnet contract is locked and keeps these rules.

## Parameter sweep

**Aims.** The task sets the aims, and each becomes a criterion:

- In the healthy community the fire is lit on 60-85 % of nights, with a streak of at least 7 nights and at least 6 smoky nights.
- Healthy supply ends between 1.00x and 1.30x genesis.
- No scenario leaves 0.80x-1.40x genesis on any night, the stress case included.
- In the healthy and the sniper-heavy community, early wood earns at least 1.5 times per EMBER what the best of the late or riskless modes earns: the sniper's completing throws, the sniper's piled wood, or any wood thrown onto a safe fire (warming).
- The opening-bell solo lighter takes at most 75 % of the throwers' mint, and the community's early wood beside it earns at least 0.5 % per EMBER per night: a clear positive yield, about a quarter of what early wood earns in the healthy community.
- Free riders lose share in the healthy, sniper-heavy and free-rider-heavy communities.
- At least 90 % of newcomers get kindling.
- A farm that wins every slot leaves the hearth with at least 60 % of what it would hold without the farm, and never empties it.
- `early_max` stays within the contract's limit of 5.0, unless nothing within it passes.

The supply range has a reason on each side. The mint is what a lit fire pays, so a working community should see supply grow. But growth beyond about 30 % in 60 nights would cost a holder who sits out more than a fifth of their share in two months: a tax, not a nudge. A dying community should lose supply slowly, through smoke and hearth burns, not collapse. Then the few who keep throwing are not wiped out, and the fire can be lit again.

**Procedure.** A staged coordinate search over a grid. Stage A varies the fire's dynamics, stage B the rewards and burns, stage C the hearth and kindling. Each stage keeps the other knobs at their current pick and runs its scenarios over 2 seeds. Among the combinations that pass the stage's criteria with stricter selection margins, it picks the one fewest grid steps from the first guess; equal distances go to the smaller relative change. The selection margins are:

- a lit rate of 65-80 %;
- healthy supply at 1.03-1.25x and a supply band of 0.85-1.35x;
- an early edge of 1.75;
- a solo lighter's share of 70 % and 0.75 % for the early wood beside it;
- free riders losing at least 2 % of their share;
- a farm that leaves 65 % of the hearth.

The stages repeat until a round changes nothing. The pick is a fixed point of the search, not a proven global optimum. The search has more than one fixed point. Started from the earlier pick instead of the first guess, it stops at `early_max` 3.0, `smoke_pct` 2 % and `hearth_cut` 20 %, which also passes every criterion. The launch values are the ones the documented command reaches from the first guess.

<!-- BEGIN generated:sweep -->
**Stage A: fire dynamics.** Knobs: `grow_pct`, `shrink_pct`, `target_start`, `target_cap`. Scenarios: healthy, fading, free_rider, solo, all_in. 81 combinations x 2 seeds; 13 pass the stage's acceptance criteria, 2 also pass the stricter selection margins. Pick: `grow_pct` = 700, `shrink_pct` = 1000, `target_start` = 20000, `target_cap` = 2500.

**Stage B: rewards and burns.** Knobs: `mint_pct`, `smoke_pct`, `early_max`, `late_lit`. Scenarios: healthy, sniper, fading, free_rider, solo, all_in. 180 combinations x 2 seeds; 46 pass the stage's acceptance criteria, 17 also pass the stricter selection margins. Pick: `mint_pct` = 400, `smoke_pct` = 300, `early_max` = 40000, `late_lit` = 2500.

**Stage C: hearth and kindling.** Knobs: `hearth_cut`, `hearth_burn_pct`, `kindling`, `kindling_per_night`. Scenarios: healthy, farm, fading, free_rider. 81 combinations x 2 seeds; 27 pass the stage's acceptance criteria, 1 also pass the stricter selection margins. Pick: `hearth_cut` = 1000, `hearth_burn_pct` = 25, `kindling` = 250, `kindling_per_night` = 10.

Healthy lit rate over 60 nights by `grow_pct` (rows) and `shrink_pct` (columns), at `target_start` = 20,000; in brackets the long-run lit rate ln(1/(1-shrink)) / (ln(1+grow) + ln(1/(1-shrink))) that the target settles to once it has found the community's capacity:

| grow \ shrink | 8 % | 10 % | 15 % |
|---|---|---|---|
| 5 % | 88 % (63 %) | 90 % (68 %) | 92 % (77 %) |
| 7 % | 77 % (55 %) | 80 % (61 %) | 85 % (71 %) |
| 10 % | 64 % (47 %) | 68 % (53 %) | 75 % (63 %) |

Healthy community by `target_start`, at the picked `grow_pct` and `shrink_pct`:

| target_start | lit nights | longest streak | smoke nights |
|---|---|---|---|
| 20,000 (2.0 % of supply) | 80 % | 27 | 12 |
| 35,000 (3.5 % of supply) | 74 % | 17 | 15 |
| 50,000 (5.0 % of supply) | 71 % | 14 | 17 |

By `target_cap`, at the other stage-A picks (nights capped: nights on which the cap lowered the next target):

| target_cap | healthy: lit | healthy: supply night 60 | healthy: nights capped | solo lighter: supply night 60 | solo lighter: nights capped |
|---|---|---|---|---|---|
| 10 % of free supply | 100 % | 1.147 | 43 | 1.147 | 43 |
| 25 % of free supply | 80 % | 1.114 | 0 | 1.271 | 22 |
| 50 % of free supply | 80 % | 1.114 | 0 | 1.201 | 0 |

Early wood's net reward per EMBER over the best sniping wood's (healthy / sniper-heavy), by `early_max` (rows) and `smoke_pct` (columns), at `mint_pct` = 400 and `late_lit` = 2500:

| early_max \ smoke | 1 % | 2 % | 3 % | 5 % |
|---|---|---|---|---|
| 1.5 | 1.16 / 2.12 | 0.96 / 1.52 | 0.82 / 0.94 | 0.60 / 0.29 |
| 3 | 2.11 / 3.43 | 1.78 / 3.38 | 1.47 / 2.69 | 1.09 / 1.44 |
| 4 | 2.66 / 4.65 | 2.20 / 4.43 | 1.85 / 3.85 | 1.40 / 1.82 |
| 5 | 3.19 / 5.13 | 2.75 / 4.75 | 2.09 / 4.77 | 1.72 / 2.40 |
| 6 | 3.58 / 5.65 | 3.19 / 5.73 | 2.37 / 5.60 | 1.98 / 2.87 |

Sniper-heavy community by `late_lit`, other stage-B knobs at their pick. "Riskless share" is the part of the throwers' mint that went to wood thrown onto a fire that was already safe:

| late_lit | early (loyal) | sniping: completing | sniping: piling on | riskless share | edge, healthy | edge, sniper-heavy | solo lighter's share of the mint | early wood beside a solo lighter |
|---|---|---|---|---|---|---|---|---|
| 0 | +2.30 % | +1.76 % | n/a | 1.0 % | 1.28 | 1.30 | 70 % | +2.03 % |
| 0.1 | +1.95 % | +0.36 % | +0.16 % | 11.0 % | 1.95 | 5.40 | 69 % | +1.94 % |
| 0.25 | +1.64 % | +0.43 % | +0.31 % | 21.5 % | 1.85 | 3.85 | 67 % | +1.89 % |

Hearth kept under a farm that wins every slot (relative to no farm) / newcomers served without a farm, by `kindling` (rows) and `kindling_per_night` (columns):

| kindling \ per night | 5 | 10 | 20 |
|---|---|---|---|
| 100 | 98 % / 90 % | 91 % / 100 % | 76 % / 100 % |
| 250 | 94 % / 90 % | 75 % / 100 % | 34 % / 100 % |
| 500 | 86 % / 90 % | 40 % / 100 % | 0 % / 100 % |

Free-rider-heavy community: supply at night 60 (x genesis) / change in the free riders' share, by `hearth_burn_pct` (rows) and `hearth_cut` (columns):

| hearth_burn \ hearth_cut | 10 % | 20 % | 30 % |
|---|---|---|---|
| 0.25 % | 1.024 / -2.3 % | 1.020 / -2.0 % | 1.019 / -1.9 % |
| 0.5 % | 1.011 / -1.1 % | 1.007 / -0.7 % | 1.007 / -0.7 % |
| 1 % | 1.010 / -1.0 % | 1.007 / -0.7 % | 1.007 / -0.7 % |

This run started from the first guess. Picks per round (the tables above show the last round):

- after round 1: `grow_pct` = 700, `shrink_pct` = 1000, `target_start` = 20000, `target_cap` = 2500, `mint_pct` = 400, `smoke_pct` = 300, `early_max` = 40000, `late_lit` = 2500, `hearth_cut` = 1000, `hearth_burn_pct` = 25, `kindling` = 250, `kindling_per_night` = 10
- after round 2: `grow_pct` = 700, `shrink_pct` = 1000, `target_start` = 20000, `target_cap` = 2500, `mint_pct` = 400, `smoke_pct` = 300, `early_max` = 40000, `late_lit` = 2500, `hearth_cut` = 1000, `hearth_burn_pct` = 25, `kindling` = 250, `kindling_per_night` = 10

The sweep's pick matches `sim/params.json`.
<!-- END generated:sweep -->

**Sensitivity.** Each knob is moved one grid step down and up from the launch value, with all others held, over all scenarios and 2 seeds:

<!-- BEGIN generated:sensitivity -->
| Variant | Healthy lit | Healthy supply | Supply band, all scenarios | Edge, healthy | Edge, sniper-heavy | Farm keeps | Criteria failed |
|---|---|---|---|---|---|---|---|
| launch values | 80 % | 1.114 | 0.998-1.318 | 1.85 | 3.85 | 75 % | none |
| `grow_pct` = 500 | 90 % | 1.143 | 1.000-1.250 | 2.55 | 4.23 | 75 % | healthy fire lit 60-85 % of nights |
| `grow_pct` = 1000 | 68 % | 1.068 | 0.990-1.369 | 1.24 | 2.23 | 75 % | healthy: early wood earns >= 1.50 x sniping per EMBER |
| `shrink_pct` = 800 | 77 % | 1.096 | 0.992-1.318 | 1.79 | 2.92 | 75 % | none |
| `shrink_pct` = 1500 | 85 % | 1.140 | 1.000-1.318 | 2.27 | 3.64 | 75 % | none |
| `target_start` = 35000 | 74 % | 1.110 | 0.995-1.385 | 2.42 | 3.14 | 75 % | none |
| `target_cap` = 1000 | 100 % | 1.147 | 0.998-1.157 | 3.69 | 3.75 | 75 % | healthy fire lit 60-85 % of nights; healthy fire has streaks (>= 7) and smoke (>= 6 nights) |
| `target_cap` = 5000 | 80 % | 1.114 | 0.998-1.522 | 1.85 | 3.85 | 75 % | no scenario leaves 0.80-1.40 x genesis on any night |
| `mint_pct` = 300 | 78 % | 1.063 | 0.993-1.229 | 2.12 | 2.63 | 75 % | none |
| `mint_pct` = 500 | 80 % | 1.159 | 1.000-1.415 | 2.09 | 3.64 | 76 % | no scenario leaves 0.80-1.40 x genesis on any night |
| `smoke_pct` = 200 | 80 % | 1.133 | 1.000-1.318 | 2.20 | 4.43 | 75 % | none |
| `smoke_pct` = 500 | 79 % | 1.076 | 0.990-1.318 | 1.40 | 1.82 | 75 % | healthy: early wood earns >= 1.50 x sniping per EMBER |
| `early_max` = 30000 | 80 % | 1.114 | 0.998-1.318 | 1.47 | 2.69 | 75 % | healthy: early wood earns >= 1.50 x sniping per EMBER |
| `early_max` = 50000 | 80 % | 1.115 | 0.998-1.318 | 2.09 | 4.77 | 75 % | none |
| `late_lit` = 1000 | 80 % | 1.115 | 0.999-1.318 | 1.95 | 5.40 | 75 % | none |
| `hearth_cut` = 2000 | 79 % | 1.104 | 0.998-1.312 | 2.03 | 2.98 | 77 % | none |
| `hearth_burn_pct` = 50 | 80 % | 1.104 | 0.991-1.318 | 1.85 | 3.85 | 75 % | none |
| `kindling` = 100 | 78 % | 1.100 | 0.998-1.309 | 2.19 | 3.20 | 91 % | none |
| `kindling` = 500 | 81 % | 1.125 | 1.000-1.333 | 1.89 | 3.10 | 40 % | sybil farm only drains the hearth slowly (keeps >= 60 %) |
| `kindling_per_night` = 5 | 80 % | 1.114 | 0.998-1.316 | 1.94 | 3.66 | 94 % | newcomers get kindling (>= 90 %) |
| `kindling_per_night` = 20 | 80 % | 1.114 | 0.998-1.318 | 1.85 | 3.85 | 34 % | sybil farm only drains the hearth slowly (keeps >= 60 %) |
<!-- END generated:sensitivity -->

## Launch parameters

`sim/params.json` holds these values with the contract's `Config` field names and units: amounts in base units as decimal strings (250 EMBER is `250000000000000000000`), rates and factors in basis points. Below, amounts are in whole EMBER.

| Field | First guess | Launch | Why |
|---|---|---|---|
| `night_ms` | 86,400,000 | 86,400,000 | One night is one day; the 60 nights are 60 days. |
| `hearth_genesis` | 400,000 | 400,000 | Kept. It pays 1,600 kindlings and outlasts 60 nights of a full farm. The founders hold the other 600,000 of the 1,000,000 genesis supply. |
| `target_start` | 20,000 | 20,000 | Kept (2 % of supply). The fire lights from night one and climbs for about 30 nights before the first smoke. |
| `target_min` | 5,000 | 5,000 | Kept; a few dozen holders can relight a dead fire. |
| `grow_bp` | 500 | 700 | With `shrink_bp` 1000 it brings the healthy 60-night lit rate inside 65-80 % and the long-run rate to 61 %. |
| `shrink_bp` | 1000 | 1000 | Kept; after one smoky night the bar is low enough that a dip does not turn into a run of smoke. |
| `mint_bp` | 500 | 400 | At 5 % the stress case leaves the supply band (1.42x). 3 % also passes. |
| `hearth_cut_bp` | 2000 | 1000 | More of each mint goes to the throwers. 20 % passes every criterion but misses one of the stricter selection margins. |
| `smoke_bp` | 1000 | 300 | At 10 % early wood loses money against sniping; at 5 % its edge falls below 1.5x. At 3 % a smoky night still costs something. |
| `hearth_burn_bp` | 100 | 25 | With the burn capped at one night's mint, 0.25 % keeps free riders losing share in a small community. |
| `early_max_bp` | 15000 | 40000 | The factor on an empty pile has to pay for the smoke risk a sniper never takes. 3.0 falls below the 1.5x edge; 4.0 is within the contract's limit of 5.0. |
| `late_lit_bp` | 5000 | 2500 | Warmers earn a little (finding 6). |
| `pool_windows` | new | 4 | Four windows of six hours (window table). |
| `target_cap_bp` | new; 2500 | 2500 | Bounds the stress case at 1.32x supply in 60 nights (finding 9). It limits one night's mint to 1 % of the free supply, not the level: 17.9x in 365 nights. |
| `min_throw` | new | 50 | 1 % of `target_min`: refuses dust and costs real throwers nothing. |
| `kindling` | 500 | 250 | Halved, with the per-night cap, so that a farm can take at most 2,500 a night. |
| `kindling_per_night` | 20 | 10 | Above the 4 arrivals a night on average. At 5, about one newcomer in ten is turned away. |
| `max_catchup` | 30 | 30 | Not simulated (it limits gas, not outcomes); kept. |
| `log_keep` | 14 | 14 | Not simulated (a view limit); kept. |
| `max_accounts` | new | 1,664 | Not simulated: 64 founders plus every kindling the genesis hearth can pay (400,000 / 250). |
| `history_keep` | new | 1,024 | Not simulated: almost three years of nights, a multiple of 32. |
| `name`, `symbol`, `decimals` | | Bonfire, EMBER, 18 | 18 decimals, as in the model. |

`max_throwers_per_night` is not in the file: the contract pays throwers lazily and drops that cap. `pool_windows` and `target_cap_bp` are new and need the contract changes described above. `yield_bp` and `mint_cap_bp` are not in the file, because kindlers and warmers were not adopted, and `mint_bp` stays.

Every criterion, for the first guess under DESIGN.md's rules and for the launch values under four rule sets:

<!-- BEGIN generated:criteria -->
| Criterion | first guess, DESIGN.md rules | launch values, DESIGN.md rules | launch values, pile position without pooling | launch values, kindlers and warmers | launch values, pooled windows (launch rule) |
|---|---|---|---|---|---|
| healthy fire lit 60-85 % of nights | **FAIL**, 90 % | pass, 80 % | pass, 80 % | pass, 78 % | pass, 80 % |
| healthy fire has streaks (>= 7) and smoke (>= 6 nights) | pass, streak 41, smoke 6 | pass, streak 27, smoke 12 | pass, streak 27, smoke 12 | pass, streak 27, smoke 13 | pass, streak 27, smoke 12 |
| healthy supply grows modestly (1.00-1.30 x genesis) | pass, 1.121 x | pass, 1.112 x | pass, 1.112 x | pass, 1.064 x | pass, 1.112 x |
| no scenario leaves 0.80-1.40 x genesis on any night | pass, 0.915-1.354 x | **FAIL**, 0.988-1.651 x | pass, 0.999-1.319 x | pass, 0.993-1.319 x | pass, 0.998-1.319 x |
| healthy: early wood earns >= 1.50 x sniping per EMBER | **FAIL**, 0.46 x | **FAIL**, 1.37 x | pass, 1.93 x | **FAIL**, 1.16 x | pass, 2.02 x |
| sniper: early wood earns >= 1.50 x sniping per EMBER | **FAIL**, -0.37 x | **FAIL**, 1.19 x | pass, 1.56 x | **FAIL**, 0.67 x | pass, 3.95 x |
| solo lighter takes <= 75 % of the throwers' mint | **FAIL**, 76 % | **FAIL**, 96 % | **FAIL**, 93 % | pass, 75 % | pass, 67 % |
| early wood beside a solo lighter earns >= 0.50 % per EMBER | pass, +0.70 % | **FAIL**, -0.18 % | **FAIL**, +0.32 % | pass, +0.64 % | pass, +1.91 % |
| healthy: free riders lose share | pass, -10.8 % | pass, -10.1 % | pass, -10.1 % | pass, -6.0 % | pass, -10.1 % |
| sniper: free riders lose share | pass, -1.3 % | pass, -4.1 % | pass, -4.1 % | pass, -3.6 % | pass, -4.1 % |
| free_rider: free riders lose share | **FAIL**, +1.2 % | pass, -2.3 % | pass, -2.3 % | pass, -0.4 % | pass, -2.3 % |
| newcomers get kindling (>= 90 %) | pass, 100 % | pass, 100 % | pass, 100 % | pass, 100 % | pass, 100 % |
| sybil farm only drains the hearth slowly (keeps >= 60 %) | **FAIL**, 1 % of the hearth without a farm | pass, 76 % of the hearth without a farm | pass, 76 % of the hearth without a farm | pass, 75 % of the hearth without a farm | pass, 76 % of the hearth without a farm |
<!-- END generated:criteria -->

The launch values pass all 13 criteria under the launch rule. Under DESIGN.md's rules they fail the supply band (the stress case without a target cap), the early edge and both solo-lighter criteria. Without pooling they fail the two solo-lighter criteria, and as kindlers and warmers they fail the early edge. The first guess fails six.

For comparison, the scenarios with the DESIGN.md first guess and rules:

<!-- BEGIN generated:guess -->
| Scenario | Supply night 60 (x genesis, seed range) | Lit nights | Longest streak | Tallest fire (EMBER) | Hearth night 60 (EMBER) | Early (loyal) | Late (fair-weather) | Sniping: completing | Sniping: piling on | Free riders' share |
|---|---|---|---|---|---|---|---|---|---|---|
| Healthy community | 1.121 (1.116-1.149) | 90 % | 41 | 155,476 | 302,277 | +1.37 % | +0.62 % | +2.95 % | +1.03 % | -10.8 % |
| Fading community | 0.927 (0.915-0.930) | 57 % | 18 | 45,840 | 281,540 | -0.15 % | +0.42 % | +2.88 % | +0.88 % | +7.8 % |
| Whale-dominated | 1.042 (1.020-1.074) | 82 % | 18 | 75,706 | 323,659 | -0.11 % | -0.23 % | +2.40 % | +0.82 % | -4.0 % |
| Sniper-heavy | 1.013 (0.999-1.035) | 78 % | 18 | 59,550 | 256,572 | -0.63 % | +0.12 % | +1.73 % | +0.67 % | -1.3 % |
| Free-rider-heavy | 0.988 (0.982-1.003) | 75 % | 11 | 43,365 | 247,138 | +0.25 % | +0.60 % | +2.96 % | +1.27 % | +1.2 % |
| Opening-bell solo lighter | 1.312 (1.311-1.313) | 98 % | 53 | 304,966 | 339,477 | +0.70 % | +0.69 % | n/a | +0.91 % | -23.8 % |
| Everyone throws everything | 1.354 (1.354-1.354) | 100 % | 60 | 355,794 | 348,217 | n/a | n/a | n/a | n/a | n/a |
| Sybil kindling farm | 1.238 (1.182-1.276) | 95 % | 42 | 238,227 | 2,380 | +0.87 % | +0.33 % | +2.90 % | +0.72 % | -19.2 % |
| Sybil splitter | 1.123 (1.090-1.148) | 90 % | 42 | 160,477 | 302,056 | +1.36 % | +0.63 % | +2.93 % | +1.04 % | -11.0 % |

Medians over 8 seeds. Early, late and the two sniping columns: net reward per EMBER thrown (mint received minus wood burned, divided by wood thrown, over all 60 nights). Sniping is split into the throws that make the fire safe and the wood piled onto a fire that is already safe. The last column: the change in the founding free riders' share of total supply from genesis to night 60.
<!-- END generated:guess -->

## Testnet variant

On testnet a night lasts 5 minutes, so a judge sees a dozen nights in an hour. The economics are those of the launch: the same `grow_bp`, `shrink_bp`, `mint_bp`, `hearth_cut_bp`, `smoke_bp`, `hearth_burn_bp`, `early_max_bp`, `late_lit_bp` and `target_cap_bp`. The rest changes for the shorter night, the small demo population and the kindling farm:

| Field | Testnet | Why |
|---|---|---|
| `night_ms` | 300,000 | 5 minutes. |
| `hearth_genesis` | 900,000 EMBER (deployed: 3,000,000) | The hearth is the judges' faucet. The bots need only 100,000 between them. |
| `target_start`, `target_min` | 400, 100 | Near what the demo bots throw together; the fire finds its level within the first hour. |
| `kindling`, `kindling_per_night` | 200, 1 (deployed: 4) | A judge's kindling is about 40 % of a typical target, so a judge can decide a night. One claim per 5-minute night caps a farm at 2,400 EMBER an hour: at least 375 hours (15.6 days) to empty the hearth. |
| `min_throw` | 1 | 1 % of `target_min`. |
| `log_keep`, `history_keep` | 48, 4,096 | The last four hours in full, and two weeks of history. |
| `max_accounts` | 4,505 | The five bots plus every kindling the hearth can pay. |

`pool_windows` stays at 4, so a testnet window is 75 seconds: a judge who throws within the first 75 seconds of a night shares the bottom of the pile with the bots that throw then.

A smoky testnet night burns at most one night's mint from the hearth, about 20 EMBER. Empty nights burn nothing, so a quiet weekend costs the hearth nothing either.

**Demo bots.** Five accounts hold the founders' 100,000 EMBER. They are implicit accounts (64 hex characters), labelled as bots on the page (`web/js/config.js`), in the README and in docs/testnet-launch.md. They follow fixed, published strategies (`testnet.demo_bots` in `sim/params.json`). They never look at who threw; the steady and the late bot look at the pile and the streak, as any player can, so a judge's wood can change what they do:

<!-- BEGIN generated:testnet_bots -->
| Bot | Behaviour | Founding balance (EMBER) | Typical throw (EMBER) | Net reward per EMBER thrown | Balance after 14 days / founding |
|---|---|---|---|---|---|
| demo-bot-early-a | early | 40,000 | 200 | +1.84 % | 1.334 |
| demo-bot-early-b | early | 30,000 | 150 | +1.74 % | 1.318 |
| demo-bot-steady | fair-weather | 15,000 | 150 | +0.83 % | 1.234 |
| demo-bot-late | sniper | 5,000 | 100 | +0.67 % | 1.307 |
| demo-bot-idle | free rider | 10,000 | never throws | n/a | 1.000 |
<!-- END generated:testnet_bots -->

<!-- BEGIN generated:testnet -->
| Testnet run (14 days, medians over seeds) | Lit nights | Longest streak | Target p10 / median / p90 | Supply day 1 / day 14 (x genesis) | Hearth at the end | Judge nights decided by the judge | Judges' share of the mint on lit nights | Judges' net reward per EMBER |
|---|---|---|---|---|---|---|---|---|
| demo bots only | 61 % | 11 | 408 / 494 / 580 | 1.000 / 1.000 | 872,484 | n/a | n/a | n/a |
| demo bots and 24 judges | 61 % | 12 | 411 / 499 / 593 | 1.000 / 1.000 | 867,307 | 36 % | 18 % | +1.53 % |

Kindling drain: at most 200 EMBER a night x 12 nights an hour = 2,400 EMBER an hour. A script that wins every claim empties the 900,000 EMBER hearth in no less than 375 hours (15.6 days), refills from lit nights not counted.
<!-- END generated:testnet -->

- The bots throw fixed amounts with ±25 % jitter, not shares of their growing balances. So the fire's level does not compound with the mint, and supply stays level over two weeks.
- Two early bots build the fire, a steady bot joins when the streak or the pile looks good, a late bot snipes (it closes small gaps), and an idle bot never throws.
- Between them they show the mechanic on the page:
  - the early bots earn most per EMBER, about 1.8 %;
  - the steady bot (0.8 %) and the late bot (0.7 %) earn less than half of that: the steady bot throws mid-night onto nights that may still smoke, and the late bot's wood is mostly warming;
  - the idle bot keeps its balance while the throwing bots grow theirs by a fifth to a third.

**Why a judge still matters.** The bots alone keep the fire alive but not safe: it is lit on about 61 % of nights (p*), and the target moves between about 410 and 590 EMBER. A judge who claims kindling and throws adds up to 200 EMBER, about 40 % of a typical target. In the run, 24 judges arrive at random times over two weeks and play 6-18 nights each. A judge whose night's single kindling claim is already taken tries again the next night. For each night a judge played, the run compares the outcome with and without the judge's wood, everything else equal:
- the judges' wood decides about a third of those nights (36 %);
- the judges take almost a fifth of the mint on the lit nights they play (18 %);
- their kindling grows by about 1.5 % per EMBER thrown per night.

If the bots stop, every missed night is empty. The target shrinks to `target_min` within about 15 nights (75 minutes), and nothing burns. Anyone can relight the fire afterwards. The page should call `settle()` until no night is due before it offers a throw, and the bots should run under a supervisor.

**The deployed values.** The runs above use the `testnet` block of `sim/params.json`. The launch changed two of its values ([testnet-launch.md](testnet-launch.md)): `hearth_genesis` 3,000,000 instead of 900,000 and `kindling_per_night` 4 instead of 1. The same run with those values (`python3 sim/bonfire_sim.py deployed`) gives the same fire and the same judges' numbers; only the hearth is larger. `max_accounts` stayed 4,505 (the five bots and 4,500 claims), so a script that wins every claim fills the sponsored seats long before it empties this hearth.

<!-- BEGIN generated:testnet_deployed -->
| Testnet run (14 days, medians over seeds) | Lit nights | Longest streak | Target p10 / median / p90 | Supply day 1 / day 14 (x genesis) | Hearth at the end | Judge nights decided by the judge | Judges' share of the mint on lit nights | Judges' net reward per EMBER |
|---|---|---|---|---|---|---|---|---|
| demo bots only, deployed values | 61 % | 11 | 408 / 494 / 580 | 1.000 / 1.000 | 2,972,484 | n/a | n/a | n/a |
| demo bots and 24 judges, deployed values | 61 % | 12 | 411 / 499 / 593 | 1.000 / 1.000 | 2,967,307 | 36 % | 18 % | +1.53 % |

Kindling drain: at most 800 EMBER a night x 12 nights an hour = 9,600 EMBER an hour. A script that wins every claim empties the 3,000,000 EMBER hearth in no less than 312 hours (13.0 days), refills from lit nights not counted.
<!-- END generated:testnet_deployed -->

**On chain.** All 79 cold nights of `bonfire-coin.testnet` so far are nights 8-15 and 35-105, on launch day. From night 106 to night 308, 133 nights were lit and 70 smoked: 66 %, close to p* = 61 % and the run's 61 % (`history()`, read 2026-11-07 11:34 UTC). That is the bots running these behaviour models against the real contract: a check of the model and the contract, not evidence about people. Up to night 310, three accounts besides the bots had claimed kindling (`state().records.kindling_claims`).

## What the simulation cannot show

- **People are not these behaviour models.** The models are simple rules with fixed probabilities. Real holders learn, copy each other, coordinate in chats, and change strategy when the rules reward it. The sweep makes sniping the strongest it can be (perfect information, exact sizing). It does not model collusion, for example a group that agrees to throw early and share the risk. Nor does it model a community racing a solo lighter for the opening bell.
- **There is no market.** EMBER has no price in the model, nobody buys or sells, and no newcomer brings EMBER other than kindling. Supply over time is the mechanic's own effect, not a forecast of what holders will do with the coin.
- **The community's capacity is assumed.** How much the healthy community throws (about 10 % of supply a night) is an input, not a result. The long-run lit rate does not depend on it, but the 60-night lit rate and the supply growth do, through the length of the climb.
- **The chain is idealised.** Throws land in the order and at the moment the model chooses. There is no latency, no block ordering, no failed or delayed transaction, no gas and no storage cost. A real sniper's last-second throw can miss the end of the night; that risk favours early wood and is not counted here. Within the first block of a night, the order of throws is whatever the chain makes it. The model always puts the solo lighter first.
- **Founders.** The model spreads the founders' EMBER over a few hundred holders. The contract's init call takes at most 64 founders, so a real launch reaches that spread through transfers after genesis.
- **The farm is the simplest one.** It wins every slot with fresh implicit accounts. Telling it apart from a newcomer is outside what the contract can do. The model shows the bound on its drain, not ways to detect it.
- **Medians over few seeds.** Scenarios use 8 seeds, the sweep 2. Medians hide the tails; the supply bands report the extreme seed.
- **The testnet judges are guesses.** When judges arrive, how long they stay and how much they throw are assumptions. The counterfactual compares nights with and without their wood, all else equal.

## Files

- `sim/bonfire_sim.py`: the model, the scenarios, the sweep, the testnet run, the charts and this document's generated blocks.
- `sim/params.json`: the launch configuration and the testnet variant, with the contract's `Config` field names and units, plus the testnet founders (demo bots).
- `docs/sim/supply.svg`, `docs/sim/target_pile.svg`, `docs/sim/reward_per_ember.svg`: the charts.
