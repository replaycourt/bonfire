# Bonfire demo video

`bonfire-demo.mp4` is the demo video of Bonfire, an entry in the NEAR hackathon track *Memecoins With Mechanics*: 1920x1080, 30 fps, 90 s, H.264 (3 Mbit/s) with AAC narration, burned-in captions, about 34 MB. `bonfire-demo.srt` has the same captions as a subtitle file, and `poster.png` is a still of the finished video. A build writes all three into `demo/video/out/` (git-ignored); the published copies live in `web/media/`.

## What is real

The video is one real night of play, end to end, on the live contract `bonfire-coin.testnet` (NEAR testnet; the contract has no access keys). Every frame of the page is a screenshot of the real page (`web/`) in headless Chrome, played by a fresh visitor through its own buttons: kindling, throws and the collection are real transactions signed by the key that browser made, relayed through the public gas keys. Nothing is mocked and no number is invented: the pile, the target, the factors, the banners, the coin's face and the transactions are what the chain returned.

The other throwers are the five demo bots, the founders of the testnet demo, labelled as bots on the page and in the video. They ran locally from `scripts/bots.mjs` during the recording, with their published strategies and with nothing but the script's own options:

- `--seed`, chosen with `tools/plan.mjs`, which replays exactly what `bots.mjs` would do for a seed (its own `planNight` and `decide`, its random streams) together with the visitor's planned throws, and settles every night with the model in `scripts/bonfire-lib.mjs`. The seed was picked so that on the filmed night the visitor throws first, the bots' early wood leaves the pile below the target, and the late bot closes the gap. The bots do not react to the visitor beyond what their strategies always do (they look at the pile).
- `--smoke 2`: on the run's second night the bots under-throw on purpose (the early bots throw a quarter of their usual wood, the steady and late bots hold back), and the visitor throws only 25 EMBER, so that night smokes. The video says so.
- `--always`: every bot plays every night it may.

Before the recording the bots played a warm-up run (`--always`) to bring the fire back after a quiet morning; the nights it lit are the flames along the strip. The video marks every stretch that is sped up with a badge ("8× sped up"); waits are cut or sped up, results are not touched.

What the build adds on top of the recording: the narration and the captions, the hand cursor (drawn from the recorded mouse positions), the badges, a list of tonight's throws as the contract's `recent_throws` names them, zooms into the page, the title, and three cards: the coin's face (the SVG the contract returned from `ft_metadata().icon` at the end of the take), the proof (`view_access_key_list` read at the end of the take, and the 60-night simulation chart `docs/sim/target_pile.svg`), and the end card.

**AI disclosure.** The narration is a synthetic voice (Piper neural text-to-speech, voice `en_US-lessac-high`). The script, the storyboard, the tools and this README were written by an AI coding agent (Claude), like the rest of the repository. The footage is the real page on the real contract, as described above.

## The recording

Recorded on 2026-11-06, nights 30 to 34 of `bonfire-coin.testnet` (12:15 to 12:41 UTC). A warm-up run of the bots (`--nights 20 --always --seed 101`, stopped after night 29) relit the fire after a quiet morning; then `scripts/bots.mjs bonfire-coin.testnet --nights 5 --always --smoke 2 --seed 281` played the filmed nights, and `tools/plan.mjs` had predicted every throw of them to the last unit.

| Night | What happened | |
|---|---|---|
| 30 | The visitor claims kindling (`CF5LCBem…`) and throws 100 EMBER 24 s after dusk (`4s6FMXvH…`), alone on the pile for 37 s at a factor of ×3.7; demo-bot-early-a 156.74 (`H2mt3UUE…`) and -early-b 150.735 (`BetjFWAX…`) in the same quarter, demo-bot-steady 135.855 in the second (`6kdrHbY5…`), demo-bot-late 100 in the last, closing the gap (`G9kUgRW1…`). LIT at a target of 599.68: the visitor's 100 earned 4.26 new EMBER, the late bot's 100 earned 1.08. The visitor collects (`5qaPmN9W…`). | firestarter: the visitor; last log: demo-bot-late |
| 31 | The smoky night: the visitor throws 25 (`7cSuriyj…`), the early bots a quarter of their usual wood, the others hold back. 118.04 of 641.66: SMOKED, 0.75 of the visitor's 25 burned. | |
| 32-34 | The bots alone, all lit: the coin's face reads LIT ×3, with the smoke puff of night 31 among its seven nights. | |

At the end of the take `view_access_key_list` returned `"keys": []` at block 276488034.

## Scenes

| Time | Scene | What is shown |
|---|---|---|
| 0-5 s | Hook | The fire roaring at the dawn of night 30, the title "A memecoin you light together." |
| 5-19 s | A fresh visitor | No wallet: *Get kindling*, the hint "Throw 100 now: it counts ×3.7", the throw, "you lit the first log" |
| 19-35 s | The bots | Night 30 sped up (badge), slowed at each bot's throw; the list of throws as the chain names them; the late bot's last log |
| 35-48 s | Dawn | LIT banner and sparks, "Your 100 wood comes back, plus 4.26 new EMBER.", *Collect* |
| 48-58 s | Smoke | The under-throw of night 31 and its dawn: grey smoke, "24.25 of your 25 wood comes back; 0.75 burned." |
| 58-68 s | The coin's face | The page's records and ledger, then the icon the contract drew: LIT ×3 and the last seven nights |
| 68-81 s | Proof | The proof drawer (0 access keys, the visitor's transactions), then `view_access_key_list` and the 60-night simulation chart |
| 81-90 s | End card | Play link, "Built at NEAR HACKATHON", "Would you throw early, or wait and snipe?" |

## How it is made

```
plan.mjs     →  the bots' seed for the nights to film
bots.mjs     →  the demo bots play those nights (run alongside the capture)
capture.mjs  →  takes/<name>/frames/*.jpg + events.jsonl + icon.svg + keys.json   (play, record the screen)
storyboard.json + voice.py  →  work/timeline.json, voice.wav, bonfire-demo.srt
compose.mjs + compositor.html  →  work/frames/*.png           (cut, zoom, captions, cursor, cards)
encode.swift  →  bonfire-demo.mp4;  probe.swift checks it and exports stills and the poster
```

1. **Plan the nights.** `tools/plan.mjs` searches seeds for `scripts/bots.mjs` and prints, for the best ones, every bot's throw (time, amount, window), every night's outcome and the visitor's credit, from the fire as the chain has it now.

2. **Record the take.** `tools/capture.mjs` waits for the planned night, opens the page in headless Chrome with a fresh profile (a fresh browser key, so a newcomer) a few seconds after dusk, and plays: *Get kindling*, a hover over a throw so the hint shows what the wood counts, the throw, the whole night, the banner at dawn, *Collect*, the under-throw on the next night and its dawn, then (after `--face-after`) a scroll to the coin's face and the proof drawer. It records the DevTools screencast (1280x720 CSS pixels at device scale 1.5, 12 to 25 frames a second on the recording machine) with a timestamp per frame, and an event log: every click, hover and cursor move, every change of the pile, the names, the hint, the balance, the banners and toasts, and each throw as `recent_throws` names it. Between the smoky night's dawn and the face it keeps two frames a second. It serves the repository itself on `127.0.0.1` (`tools/serve.mjs`), so the page runs exactly as GitHub Pages serves it.

3. **Cut it.** `storyboard.json` names, per scene, stretches of the take by their events (`"from": "click:Get kindling-1.2"`, `"to": "throw:demo-bot-late+2"`), a playback speed, a zoom, the narration and the caption placement. Anchoring on events rather than seconds means a new take mostly needs no re-cutting.

4. **Speak it.** `tools/voice.py` speaks every cue with [Piper](https://github.com/OHF-Voice/piper1-gpl) (`en_US-lessac-high`, slowed to length scale 1.2, calm), measures the clips, resolves the anchors against the take and lays everything out on one timeline. A scene lasts as long as its clips or its narration, whichever is longer.

5. **Compose it.** `tools/compose.mjs` opens `tools/compositor.html` in headless Chrome, which draws, for every output frame, the right recorded frame (crossfading between two recorded frames, so a slow recording plays smoothly at 30) with the zoom, the caption, the hand (it fades out when it rests), the badges, the throw list and the cards. Frames whose state did not change are captured once.

6. **Encode it.** `tools/encode.swift` (AVFoundation, no ffmpeg) writes H.264 High (3 Mbit/s, `meta.videoBitrate`) with AAC audio. `tools/probe.swift` prints the result and exports stills; the poster is the still at `meta.posterAt`.

## Rebuild

Requirements: macOS (`afconvert`, `swiftc` with AVFoundation), Google Chrome, Node 22+, Python 3.8+, and the voice:

```sh
python3 -m venv <venv> && <venv>/bin/pip install piper-tts
export BONFIRE_PIPER_PYTHON=<venv>/bin/python
export BONFIRE_PIPER_VOICES=<dir with en_US-lessac-high.onnx and .onnx.json>
```

The voice model is `en_US-lessac-high` from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/lessac/high). Without Piper, set `"engine": "say"` and a macOS voice name in `storyboard.json`. No ffmpeg and no npm packages are needed.

Plan and record (each take is new nights on testnet, so the numbers will differ; the storyboard anchors on events and usually still resolves). The bots need their keys (`BONFIRE_BOTS`, see `docs/testnet-launch.md`); keep the machine awake, a sleeping Mac misses its nights:

```sh
export BONFIRE_BOTS=…                               # the bots' seeds, as for scripts/bots.mjs
node demo/video/tools/plan.mjs bonfire-coin.testnet --nights 5 --smoke 2 --visitor 1:22:100,2:25:25
#   → a seed and the first night N of the run; start the bots during night N-1 (after its first 45 s):
caffeinate -is node scripts/bots.mjs bonfire-coin.testnet --nights 5 --always --smoke 2 --seed <seed> &
caffeinate -is node demo/video/tools/capture.mjs --out takes/night --night <N> --face-after <N+4>
```

Then build:

```sh
TAKES=takes demo/video/tools/build.sh                 # writes demo/video/out/bonfire-demo.{mp4,srt} and poster.png
STILLS=2,20,45,70 TAKES=takes demo/video/tools/build.sh   # also exports those seconds as PNGs into $WORK/check
```

`WORK` (default `$TMPDIR/bonfire-video`) holds the voice clips, the composed frames (a few GB) and the compiled Swift tools; `WRAP` can prefix every step with a memory or time cap wrapper. A quick look at the cut without encoding: `node demo/video/tools/compose.mjs --work $WORK --stills 3,40,70`.

The take itself (frames and the browser profile with the visitor's key) is not in the repository.

## The short cut on X

`storyboard-short.json` is a second, shorter cut (about 81 s) for a post on X, built by the same tools from two takes. It is not in the repository: the repository keeps one video (the 90 s cut above, in `web/media/`); the short cut lives on X, linked as the demo of the submission.

| Time | Scene | What is shown |
|---|---|---|
| 0-4 s | Hook | The fire of night 30, the title |
| 4-12 s | First visit | A fresh visitor opens the page and last night replays in five seconds: "Night 296, replayed in five seconds", the pile rising against the dashed "target 420", the banner "Replay of last night" |
| 12-23 s | A fresh visitor | *Get kindling*, the hint "it counts ×3.7", the throw (night take, parts sped up and badged) |
| 23-33 s | The bots | Night 30 sped up, slowed at the early bots and at the late bot's last log |
| 33-44 s | Dawn and smoke | The lit dawn of night 30 ("Your 100 wood comes back, plus 4.26 new EMBER") and the smoky dawn of night 31 |
| 44-60 s | Proof, try to cheat it | The proof drawer (0 access keys), then *Throw wood on tomorrow's fire* and the contract's refusal |
| 60-66 s | Supply | The supply chart as change since the first night shown, and the coin's face beside it |
| 66-72 s | The card | The share card the dawn banner offers ("Save your card") |
| 72-81 s | End card | Play link, "Built at NEAR HACKATHON", "Would you throw early, or wait and snipe?" |

What is real, beyond the night take described above: the `tour` take was recorded on 2026-11-07 at night 297 (10:30 UTC) by `capture.mjs --tour`, a fresh visitor's first minute. The page replayed night 296 by itself; *Throw wood on tomorrow's fire* sent one real transaction, `AkYsBfdB7DhUQCuhQajZ5GTCuvpZ3LaTrA5Y75vnNjko`, and the contract answered `"ok": false, "error": "the action is for night 298, but this is night 297"`. The take predates the *Save your card* button, so the card is drawn by `tools/card.mjs` with the page's own `nightResult` and `drawCard`, from the chain as it stood at the block of the night-30 visitor's collect transaction (`5qaPmN9W…`): `night(30)`, the visitor's uncollected credit (100 wood, 104.26 back) and `ft_metadata().icon` of that dawn (LIT ×15).

Build it (the tour sends one refused throw; `card.mjs` reads past blocks from an archival RPC, `BONFIRE_ARCHIVAL_RPC`, default the public FastNEAR one):

```sh
node demo/video/tools/capture.mjs --tour --night <N> --out takes/tour
node demo/video/tools/card.mjs --take takes/night --night 30 --block <block of the visitor's collect transaction>
STORYBOARD=demo/video/storyboard-short.json NAME=bonfire-short OUT=<dir> TAKES=takes demo/video/tools/build.sh
```
