# Bonfire on testnet: the page run

The scripted staging run ([`testnet-stage.md`](testnet-stage.md)) checked the contract through its own scripts. This run checked the web page: two new players opened `web/?contract=stage` in headless Chrome, a desktop and a phone, and played five nights on `bonfire-stage.testnet` beside the demo bots, through the page alone. A driver compared what the page showed with the contract's views after every step.

**Result:** no contract bug. The page did everything the ritual needs on both screens: first visit, kindling, throws in early and late quarters, settling at dawn, LIT and SMOKED banners, collecting by tap and by the next throw, reloads, the strip, chart, records, coin face and Proof drawer. Every amount it showed matched the chain to the hundredth of an EMBER, and no transaction failed. Eleven page faults were found, mostly in wording, layout and network handling. All are fixed in `web/`, with tests (75 unit tests, all passing), and the fixes were checked in two more passes on the chain.

## Setup

- **Staging deployment in `web/js/config.js`:** the eight function-call keys of `bonfire-gas.testnet` from the git-ignored `.secrets/gas-pool-bonfire-stage.testnet.json`, and the code hash `EWcaLXmKxqtKqWGRE1NAnZQTq7i2q87JVUkhYi39mg5z`. `view_account(bonfire-stage.testnet)` reports this hash, the base58 form of `contract/WASM_SHA256`. Before the keys went in, `view_access_key_list(bonfire-gas.testnet)` confirmed that every one of the eight is a function-call key for `bonfire-stage.testnet` with methods `act`, `settle` and `collect` and about 0.5 NEAR of allowance. The account's full-access key is not among them. The final deployment entry is unchanged, apart from an empty `bots` map (see bug 1). `.secrets/` stays ignored (`git check-ignore`). `web/test/config.test.mjs` allows these public keys in `config.js` only, and checks that each secret belongs to its public key.
- **Page:** served with `python3 -m http.server` on 127.0.0.1 from the repository root. Opened as `/web/?contract=stage`.
- **Browsers:** headless Chrome 156, driven over the DevTools protocol by a driver modelled on Lantern Row's `scripts/cdp.mjs` and `e2e-browser.mjs` (kept outside this repository). It used two fresh profiles:
  - desktop: 1440 × 900;
  - phone: 390 × 844, device pixel ratio 2, touch input, iPhone user agent, taps sent as touch gestures.

  The driver read the page's DOM and queried the contract itself (`estimate`, `state`, `holder`, `ft_balance_of`, `night`, `history`, `records`, `ft_metadata`, `audit`). For the share preview it used the independent model in `scripts/bonfire-lib.mjs`, not the page's own `logic.js`. It also recorded every console message, every failed request and every transaction the pages sent.
- **Bots:** the five demo bots of `scripts/bots.mjs` with `--always`, `--cold 2` (nobody throws on the run's second bot night) and `--quiet 3` (the bots do nothing on the third, not even settle, so the page must). The Mac was kept awake with `caffeinate -is`.

The players:

| Player | Account |
|---|---|
| desktop | `fbd39338a479cf5e76f69ae5012100e1b90a49dea6adce7bffcd2ea7e2776bba` |
| phone | `6c63c30356fd0539da3a15cdf7476bc3a85868a7e73ebf1efaaab2612b2b4638` |

## The run

Chain nights 34 to 38, 2026-11-06 08:18 to 08:39 UTC. A first attempt (night 32) stopped in its first minute because the driver tapped the header button "How it works", which the phone layout hides by design. Its only transaction was the desktop page settling the cold nights 30 and 31 (`GG16pjsYp7eCZmodXUAbyoKEWnvFHCcoUqaJizeKv61`). The cold nights 21 to 29, left over from the staging run, had been settled by the page opened for a first look before that.

| Night | Plan | What happened |
|---|---|---|
| 34 | first visit; the desktop takes kindling and throws 100 | Both pages explained themselves: the rule line under the clock, "100 EMBER of wood needed before dawn. Be the firestarter.", "Your EMBER 0" and the "Get kindling" button. The desktop page first settled the two cold nights before it. Kindling arrived (200; `ft_balance_of` 200). Only one claim is paid per night on testnet, so the phone was told "Tonight's kindling is handed out." The desktop threw 100 on the target of 100 alone: it was firestarter and last log, the phone saw the same pile and names. **LIT ×1.** |
| 35 | the phone takes kindling; the desktop collects by tap, then throws in quarter 1, the phone in quarter 3; bots play | Both banners showed **LIT ×1** for night 34. The desktop was paid 100 back plus 3.6 new, as its preview at dawn had said; the phone, which had not thrown, read "1 thrower shared 3.6 new EMBER". The phone got its kindling. The desktop reloaded with its credit pending, and the credit survived. It then collected by tap (103.6). Throws: desktop 50 in quarter 1 (×3.3), phone 50 in quarter 3 (×0.25, above the target); the bots threw 571.04. The desktop reloaded again in quarter 3: wood, share preview and key survived. **LIT ×2**: 671.03 on a target of 107; the desktop's quarter-1 wood earned 1.55, the phone's quarter-3 wood 0.11. |
| 36 | the bots stay away; 25 + 25 is too little | The phone collected by tap (50.11). The desktop's throw of 25 collected its 51.55 first, without a tap. The phone threw 25 in quarter 2. 50 on a target of 114.49. **SMOKED.** |
| 37 | the bots do nothing; a page settles; the players light it alone | The phone's page settled night 36. Both banners read "24.25 of your 25 wood comes back; 0.75 burned." The phone reloaded with that credit pending, and it survived. The desktop collected by tap; the phone's next throw collected its own. Desktop 100 in quarter 1, phone 50 in quarter 3: the phone's throw crossed the target of 103.04, and its page named it the last log ("you · 50"). The phone reloaded mid-night. **LIT ×1**, lit by the two players alone. |
| 38 | results | Banners, then both collected by tap (103.5 and 50.2). The strip showed nights 34 to 37 as LIT ×1, LIT ×2, SMOKED, LIT ×1, as `history()` has them. The supply chart ran to night 37. The records tiles and tally equalled `state().records`. The coin face was `ft_metadata().icon`, live (`LIT ×1`). The Proof drawer named the contract, the code hash and each tab's transactions. Final balances: desktop 207.909469, phone 199.573287, both equal to `ft_balance_of`. `audit()`: balanced, ledger true, nothing owed. |

| Night | Outcome | Target | Pile | Throwers | Minted | Burned | Firestarter | Last log |
|---|---|---|---|---|---|---|---|---|
| 34 | LIT | 100.00 | 100.00 | 1 | 4.00 | 0 | desktop | desktop (100) |
| 35 | LIT | 107.00 | 671.03 | 6 | 4.28 | 0 | desktop | demo-bot-early-b (168.81) |
| 36 | SMOKED | 114.49 | 50.00 | 2 | 0 | 6.08 (1.50 of the pile, 4.58 of the hearth) | desktop | – |
| 37 | LIT | 103.04 | 150.00 | 2 | 4.12 | 0 | desktop | phone (50) |

### What was checked

The driver made 120 checks, and 112 passed. The 8 that failed:

- **4 were the driver's own doing.** On a phone, a tap throws at once and there is no hover, so the hint under the chips describes the default chip. When the driver tapped a different chip, it compared the hint with the wrong amount. The amounts the hint did describe agreed with `estimate()`. On the page's side, nothing showed which chip the hint meant (bug 11).
- **4 were the network:**
  - FastNEAR answered some calls with HTTP 429, a rate limit hit by two browsers, the bots and the driver on one address. The answer comes without CORS headers, so Chrome logs it as a CORS error. These came in bursts right after a reload.
  - After falling over to dRPC, a page sent three transactions there. The free dRPC plan answers `send_tx` with HTTP 408 ("Request timeout on the free plan"). Each time, the page found the transaction by its hash, and it had gone through.
  - No call was lost and no transaction failed. Still, the fallback was clumsy (bug 5).

The checks that passed, by kind:

| Check | Result |
|---|---|
| first visit | a fresh 64-hex key per profile, unregistered, balance 0, kindling offered, the rules and "How it works" (built from `config()`) on screen |
| share preview against `estimate()` | the factor in the hint equalled `estimate(amount).factor_bp` (25000, 32990, 2500, 36724, 25442). The "+x new EMBER" equalled the gain recomputed from `state()`, `holder()` and `estimate()` with the model in `scripts/bonfire-lib.mjs` |
| pile, target, quarter bar, firestarter, last log | as `state()` after every throw, on both pages |
| "If it catches" | equal to the pool times the player's weight over the total weight from the views after every throw. The value shown just before dawn equalled what the night then paid, on every lit night, for both players |
| banners | the night, the word (`LIT ×n`, `SMOKED`) and the player's amounts as `night(n)` and `holder()` give them |
| ready to collect | the amount equal to `holder().pending` |
| collecting | by tap: 5 times, the toast naming the amount; by the next throw: 2 times, in the `act` result's `collected`. After each one, the page balance equalled `ft_balance_of`, and `ft_balance_of` equalled `holder().balance`, which equalled credited plus pending |
| reloads | 4 reloads (two with a credit pending, two with wood on the pile): the same key, balance, wood, credit and share preview |
| dawn | the pages settled every night of the run (the phone's page each time; on night 36's dawn the bots were quiet on purpose) |
| results | strip, chart, records and coin face as above; the Proof drawer listed 7 and 2 transactions (the phone's list restarts with each reload) |
| console | no page exception; the only errors were the network ones above |

### Transactions

All by the pages, through the public gas keys. Gas is the whole transaction.

| UTC | Page | Call | Tgas | Transaction |
|---|---|---|---|---|
| 08:18:47 | desktop | settle (nights 32-33, cold) | 2.90 | `6JBUbiGtyiAJ5WCQqzV1UXxULCUnQzjDbBT5ZnwTFM5m` |
| 08:19:09 | desktop | act: claim_kindling (night 34) | 2.50 | `E4JurWE3RcAfhEQfTqsxnf1FDWaDsupcHw1k5CeqhoSq` |
| 08:19:20 | desktop | act: throw 100 (night 34, quarter 1) | 3.01 | `F6xK8TBiXxJUjFKJrgoGR5T86XFiJ8i21S9rzqH4vsBA` |
| 08:23:39 | phone | settle (night 34, LIT) | 2.73 | `2FBk42CgEVT1MzjDfzknP8KsvUJdZDd4t6i5aZFLCY3H` |
| 08:23:40 | desktop | settle (nothing left: settled 0) | 1.78 | `99wyKYfFyL95tR1ZAU6znAEyi2uWoPP2cWV9DwbF3eh4` |
| 08:23:44 | phone | act: claim_kindling (night 35) | 2.50 | `7xvGb5kjiBzDUX2q4D7XfrhbK5uSTpQKko8AoijBgJUc` |
| 08:24:02 | desktop | act: collect 103.6 (tap) | 2.84 | `NHRCbrVTPYMwm1BAkypRzSp7Qjv5a6XKsccRhTAHMjw` |
| 08:24:25 | desktop | act: throw 50 (night 35, quarter 1) | 3.00 | `6dT2hG8xDii8a5ru1rcvy7X8Ms3bVeqpompnm5TebwMv` |
| 08:26:19 | phone | act: throw 50 (night 35, quarter 3) | 3.02 | `GUZ2LKWzjD8UDQqFJMggnHhGctKaJNwFeu1iK2ApgJdt` |
| 08:28:40 | phone | settle (night 35, LIT) | 2.76 | `BEDNgq5HBuejcs2MxhRRRYSrpfHCD8PX7qhYzj6Ks9Md` |
| 08:28:40 | desktop | settle (settled 0) | 1.75 | `1nuMsVxjqreErAmd9YeheJYufzw38dEkYjSXyMJTChZ` |
| 08:28:45 | phone | act: collect 50.11 (tap) | 2.64 | `F4Wa52LrXVrqmicDNQ2mXvzZrQoEqD8mtBiuKuRG9pHG` |
| 08:29:19 | desktop | act: throw 25 (night 36), collecting 51.55 first | 3.29 | `6xCkUrG3mMMA7sNkrv3XCmsEN1psbJ4wACBJt25yXG2H` |
| 08:30:27 | phone | act: throw 25 (night 36, quarter 2) | 3.01 | `HcKciks7Yxbe39Caa87rjgJ5Y2esSyTxitum2caQAfCD` |
| 08:33:38 | phone | settle (night 36, SMOKED; the bots were quiet) | 2.74 | `AjxrJmUx6Xubrr1KgPYCdAesULTw16WChKFGqxh3j39o` |
| 08:33:43 | desktop | settle (settled 0) | 2.01 | `FWRmj8DjKfLHgCorg2wufDLzRFfmAAGxkCNKoXxQ8WxW` |
| 08:33:50 | desktop | act: collect 24.25 (tap) | 2.62 | `d1ZbeRM39fDG2xunetmZZegrVUyqPfzAxmdu58cNvdy` |
| 08:34:09 | desktop | act: throw 100 (night 37, quarter 1) | 3.00 | `6NL9mDX84tSZN5ncF1vpmA8ABnmTTt5YD1EEi7ShKRk5` |
| 08:36:32 | phone | act: throw 50 (night 37, quarter 3, the last log), collecting 24.25 first | 3.28 | `DXoT87LZcM3VkevmUmJcPwmmFpqEFFBjeTSo5okbSReo` |
| 08:38:38 | phone | settle (night 37, LIT) | 2.77 | `FAkodje4thMpEyKrWkiea6rB7ivibVX1xFrYa7yAFFSM` |
| 08:38:39 | desktop | settle (settled 0) | 1.78 | `BbQr6dtBAmAh9VoP5TqZYPTtwNKd9MtRwyTPCLg2SzvT` |
| 08:38:46 | phone | act: collect 50.2 (tap) | 2.64 | `rGo92eBewWdLJCyVTy4nByfFqUh3QLFiGeD4jQBuu1W` |
| 08:38:49 | desktop | act: collect 103.5 (tap) | 2.84 | `LzT68DXGm7kVPqk1WEfC4Th7HJmZ9nbJdQVcKgMvznv` |

The bots, on night 35: early-b throws 168.81 `8sbbaBZAiZMmeSE1wMDRpvSjgGSkXWNEB9zBuVnn9KJK`, early-a 170.84 `EK5sf3D9TteMU4cpYUm2QL3hbAH2jYtpEHTAsrF1LREj`, steady 131.385 `ERJ55hGNNZtTAMz99ePwQB131brUd24dzPx17L2uBUzb` and late 100 `AQbctABfGK1XN1b18DisdpVk6o9Y1272gCkMDHVEY4SU`. At night 36's opening: a settle (settled 0) `FUA6qVpHiAaqcNqsqb43yQitTd1YtjbAFp8YmL5qqsjk`, then collections `H9RXcJZbjqWLpjK6yREXPv5avKYoy7FTdriD2YFZFMbH`, `47S5C2vdXCyae96f7uJ7yZQ3uATjjdhr3UUVNcCX4HHs`, `7GzQM5jNdijL5aHARV9Z9ZmEjRPbbpFHtsZzL8kgCtno` and `CSQtgcrDEXYifsHdoi7KrSTLhLkuzgDRaNGmfU6VShM`.

`scripts/bots.mjs` itself stopped at its first dawn. A page had used the same gas key a moment earlier, and the bots' signer took the `InvalidNonce` as fatal. The bots that played above ran in a small wrapper that retries such a call. It could not save their last settle either: five retries in a row met a nonce the pages had just used. See "Outside the page".

## Bugs found and fixed (all in `web/`)

1. **The demo bots were not labelled.** `docs/SIMULATION.md` and `testnet-stage.md` say the bots are labelled as bots on the page. The page showed them as `f057…6bb0`, like any player. Now each deployment in `config.js` has a `bots` map (account → label). The staging entry lists the five founders, and the final entry stays empty until its deployment. `nameOf` uses the map on the Tonight card, in the banner and in the scene's cheers: "Last log demo-bot-early-b · 168.81".
2. **The credit was counted twice, to the eye.** The page showed "Your EMBER 203.6" and, below it, "+103.6 from night 34, ready to collect". The balance already includes the credit, as wallets show it (`ft_balance_of`), so a reader added the two and got 307.2. The text now reads: "+103.6 from night 34 is already in your balance. Collect it now, or your next throw will."
3. **"about +0 new EMBER".** A player alone on tonight's pile already holds the whole mint, so more wood cannot raise its share, and the hint offered "+0". It now reads: "Tonight's new EMBER is all yours so far; more wood helps the fire catch." A gain that rounds to nothing says so in words.
4. **The Proof drawer.**
   - Long values (the code hash, the player's account, the "Owed" line) ran out of the drawer on desktop and phone, and were cut off. They now wrap.
   - The code hash was shown but never compared. It is now checked against the deployment's `codeHash`: "· matches the build in the repository", or a red mismatch naming the expected hash.
   - "Owed: 0 EMBER to throwers of 0 settled nights, until they collect" now reads "nothing · every thrower of a settled night has collected".
5. **The RPC fallback flipped and stuck.**
   - Every failed call moved the page to the next host. Three polls failing at once flipped it three times, so it could land back on the failing host.
   - Once on dRPC, the page stayed there and sent its transactions there, and dRPC's free plan answers `send_tx` with 408.
   - Now a host that fails rests for 30 seconds, and failures at the same moment switch hosts only once. Afterwards the page returns to FastNEAR.
6. **Every open page settled at dawn.** In the run, each dawn brought a settle from both pages, and the second did nothing (4 of the 8 page settles, about 1.8 Tgas each, plus nonce clashes on the shared keys). Now a page waits a random moment of up to 5 s, asks `state()`, and settles only if a night is still due and its tab is visible. A hidden tab settles when it is shown again, if the night is still due by then. This thins the duplicates without removing them: two visible pages that pick moments within about 1.5 s of each other both still send one. The third pass below ran with a first version that waited at most 2.5 s, and showed exactly that. A no-op settle costs about 1.8 Tgas.
7. **Collecting for others rarely helped.** Each round looked at only the two newest throwers in `recent_throws`. Those were usually bots that had already collected for themselves. The round also gave up until the next dawn whenever the player's own move was in flight. Now a round checks up to six candidates and relays up to two collections. When the player is busy, it looks again eight seconds later.
8. **The moon crossed the rules.** On the phone, the moon's path ran behind the four lines of rules for about a third of every night. On the desktop it grazed the last line. The path is now placed below the clock and the rules, measured from the page.
9. **Kindling.**
   - A newcomer who comes just after another (testnet pays one claim a night) was told to "come back next night". The page now counts down: "The next claim opens at dawn, in 3:12."
   - "How it works" said "Newcomers get 200 EMBER from the hearth, once, 1 per night". It now says "A newcomer gets 200 EMBER from the hearth, once. The hearth pays one claim a night, first come, first served."
10. **Banner names.** "Firestarter you · last log you (100)" now reads "Firestarter: you · Last log: you (100)".
11. **Which chip the hint describes.** The chip the hint describes is now marked, which matters on phones, where nothing can be hovered.

New tests:

| Test file | What the new tests cover |
|---|---|
| `test/logic.test.mjs` | bot labels in names and banners, the hint's three cases, the credit text, the kindling countdown, the moon's path, settling once per dawn, collecting for others |
| `test/near.test.mjs` | three failures at once switch hosts once; the first host is used again after its rest; a 408 rests a host |
| `test/ui.test.mjs` (new) | "How it works" and the Proof drawer (hash check, owed text, wrapping cells) |
| `test/config.test.mjs` | the gas keys and bot map of every deployment |

## The fixes on the chain

| Pass | Nights | What it showed |
|---|---|---|
| second | 40 | The same two players and the bots played one more night with the fixed page: <ul><li>the hint for a player alone on the pile;</li><li>"Last log demo-bot-early-b · 168.81" on both screens, and "Firestarter: you · Last log: demo-bot-early-b (168.81)" in the banner;</li><li>the moon under the rules at midnight;</li><li>the Proof drawer with no row past its edge and the hash marked as matching;</li><li>the new credit text;</li><li>both collections by tap.</li></ul> |
| third | 42-43 | Two new visitors, with fresh profiles: <ul><li>The desktop took night 42's kindling.</li><li>The phone read "Tonight's kindling is handed out. The next claim opens at dawn, in 1:48.", and six seconds later "… in 1:42.".</li><li>After dawn the phone's page showed "Get kindling", and the claim paid 200.</li><li>No console error, no failed request.</li></ul> |

Second pass transactions:

| Who | Transactions |
|---|---|
| pages | settles `6Hqv7FnnqcUhUGBT2Fxssm7V9sMVCoj5vfjYR1qXyp6n`, `DoU9KsPHokKW7Bnp69S1awc4A6c3PxSr3CzB5R4hH9ZB`, `5DEmcxAfzARqghAevqZevjSwjeafa5SitCDZZFAWqPGe`, `4EGhN5gxHNwAq4ZTaUnfz1r2aw6aVc7TFd2Hu6LPzDYU` and `E3SSxLJADYwzxxwxbxnYmQHo4t2hkbVeLZURojmTvpt7`; throws `8RnwPUSKoRYAG97XXe1LrrLDweys3c7ECWn28CuDXca4` and `5EfWAGtqRzzjKDo6Gy853fe5FVN8nPKTuwJEb5kSu86s`; collections `CfhkfDDYHe24s8ddSkzYdcRsKSNXtkjfweEEawUiHcAN` and `7KTq1ij3j9GKDoBihedBwpJxmBt96eqojrz6ES2RRwBy` |
| bots | `7epJxPHTamKLwG4vW9z5S7KsNFj4UuaQZ5gqFncv633o`, `4RieWrdV2yFmWjC4Kfa5U7CUJbofdXj785efeE7rMsPB`, `AzpmFoHmPWfZgM6JJ4ioM3hAq8ybCuZrcTcKZmd3wYMJ`, `9EW3Ktr21D8BPsENAbGDYYCKBDtugbbFAFVTwkFTB9rD`, `ECVVdPbYegFb2aAspqdZMd8ujDTCkYhQ2U2dNL7BBy5V`, `2ekCxunkq8NyYT3sUuAzihstNqt9YnGJADqxi98Vbo39`, `BbiLEAvTiwzFk6JdnfWzHca5gmU7ATi5eadcanjcE4op`, `7uhiGRoBoBxFKEXMr4zjwpfvSUYAj2EU8J6nC9dYKEc7`, `ySpZxyQ6HGGvHwzJEm9Ma5Hrmj2Tx2WESwucDiC8LxK` and `4BubMDN3oan6DF5v8ZQaCapZTw7S3Gq1pC68Z4Qpmb2S`. `audit()` afterwards: balanced, ledger true, nothing owed |

Third pass transactions:

| Transaction | What |
|---|---|
| `DoD3oCzr5MABp1eMdZFCpAwpk7isrZyH5vhckwZaFj36` | settle of night 41, by the desktop page as it opened |
| `ixFWM7kKaYJDmbomvGPgPWtsia1ggPDreK7T8x1sJ6F` | kindling, night 42 |
| `DdNYBfsG6Migvr1roC9w8YUyGtSVXVekNuNpWBEMe7F1` | settle of night 42, by the phone page |
| `6pMKYjHMEtijpMeV5MFaFv3ye6b5cJ8Ti89woC4Hnghr` | the desktop page's settle one second later, which did nothing (see bug 6) |
| `ANwzgFE8wuW5RCWUJb8asJoiic54iZBA14A1g7yf2hAm` | kindling, night 43 |

## The contract

No bug. Every amount the page showed or received matched the views and the outcome of the ritual. Two observations belong on record before the keys are deleted:

- **`estimate()` during a backlog uses the unsettled night's target.** At 07:42 UTC, night 21 was still open with target 230.77 and eight nights were due. `estimate("50000000000000000000")` returned night 29, window 1, `factor_bp` 36750. A throw at that moment would first settle the eight cold nights, which take the target to its floor of 100, and would then weigh 32500 (×3.25). The view applies only `target_min` to the stored target (`views.rs`, `estimate`), not the shrink of the due nights. This is a view only: no amount is affected, and the page never shows it, because it does not ask while a night is due.
- **Kindling pays one claim per night on testnet.** With five-minute nights that is twelve newcomers an hour. A second visitor who arrives in the same night waits up to five minutes (the page now counts down). This is a launch parameter that cannot change after the keys are deleted: worth a look before the final launch if several judges may arrive at once.

## Outside the page

- **`scripts/bots.mjs` and gas keys shared with live pages.** The signer in `scripts/near-lite.mjs` reads a key's nonce once and stops the run on `InvalidNonce`. Beside open pages that use the same public keys, that happens within minutes, usually at dawn. Bots meant to run for days beside the public page need a signer that re-reads the nonce and retries.
- **FastNEAR rate limits** (HTTP 429, without CORS headers) came quickly from one address with two browsers, the bots and the driver. Judges behind one network address could meet them too. The page recovers through its fallback.
- The screenshots (desktop and phone at every step above) were looked at one by one. The faults they showed are bugs 2, 3, 4, 8, 9, 10 and 11. They are not part of the repository.
