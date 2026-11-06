#!/usr/bin/env python3
"""Runs the golden scenarios of tests/golden.rs through the reference model in sim/bonfire_sim.py
and prints the expected numbers as Rust constants, to paste into tests/golden.rs.

    python3 contract/tests/golden_sim.py > /tmp/golden.txt

The model is imported, not changed. Each scenario uses the launch parameters of sim/params.json
("simulation" block) with its own founders, and a fixed script of kindling claims, transfers and
throws (night, time in the night, account, amount). After every night the script prints what the
model settled and every account's balance; the contract must reproduce all of it once every
thrower has collected.
"""

import importlib.util
import json
import os
import sys

sys.dont_write_bytecode = True  # leave no __pycache__ in sim/
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
spec = importlib.util.spec_from_file_location("bonfire_sim", os.path.join(ROOT, "sim", "bonfire_sim.py"))
sim = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sim)

E = 10 ** 18
H = 3_600_000  # one hour in ms; a launch night is 24 hours, a window 6 hours

# (night, ms into the night, action, account, other, EMBER)
# Scenario "pooling": a large free supply, so the target cap never binds. Lit nights with several
# throwers in several windows, a crossing throw, late wood, a smoky night, a cold night, a solo
# lighter, kindling and a transfer.
POOLING = {
    "founders": {"alice": 120_000, "bob": 60_000, "carol": 40_000, "dave": 20_000, "erin": 10_000},
    "nights": 6,
    "script": [
        (1, 1 * H, "throw", "alice", "", 8_000),
        (1, 2 * H, "throw", "bob", "", 4_000),
        (1, 3 * H, "kindle", "frank", "", 0),
        (1, 7 * H, "throw", "carol", "", 6_000),
        (1, 13 * H, "throw", "dave", "", 4_000),
        (1, 19 * H, "throw", "erin", "", 2_000),
        (2, H // 2, "throw", "alice", "", 5_000),
        (2, 8 * H, "throw", "bob", "", 5_000),
        (2, 10 * H, "transfer", "bob", "frank", 1_000),
        (4, 0, "throw", "alice", "", 0),  # 0: exactly the target
        (4, 20 * H, "throw", "frank", "", 200),
        (5, 1 * H, "throw", "alice", "", 3_000),
        (5, 7 * H, "throw", "carol", "", 6_000),
        (5, 14 * H, "throw", "alice", "", 9_000),
        (5, 19 * H, "throw", "dave", "", 3_000),
        (6, 23 * H, "throw", "erin", "", 1_000),
    ],
}

# Scenario "cap": a small free supply, so the target cap binds; solo, paired and smoky nights.
CAP = {
    "founders": {"alice": 40_000, "bob": 24_000, "carol": 16_000},
    "nights": 6,
    "script": [
        (1, 0, "throw", "alice", "", 0),
        (2, 2 * H, "throw", "bob", "", 6_000),
        (2, 3 * H, "throw", "carol", "", 6_000),
        (3, 5 * H, "throw", "alice", "", 4_000),
        (3, 6 * H, "throw", "bob", "", 4_000),
        (5, 0, "throw", "alice", "", 0),
        (6, 1 * H, "throw", "alice", "", 12_000),
        (6, 2 * H, "throw", "bob", "", 12_000),
    ],
}


def params(founders):
    with open(os.path.join(ROOT, "sim", "params.json")) as fh:
        cfg = json.load(fh)["simulation"]["config"]
    total = sum(founders.values()) * E
    return cfg, dict(sim.DESIGN_GUESS, **sim.from_config(cfg, total))


def run(name, sc):
    cfg, prm = params(sc["founders"])
    fire = sim.Fire(prm, {a: v * E for a, v in sc["founders"].items()}, rule="pooled")
    named = {s[3] for s in sc["script"]} | {s[4] for s in sc["script"] if s[4]}
    accounts = list(sc["founders"]) + sorted(named - set(sc["founders"]))
    rows = []
    script = []
    for night in range(1, sc["nights"] + 1):
        for (n, t, kind, who, other, amount) in [s for s in sc["script"] if s[0] == night]:
            amount = amount * E if amount else (fire.target if kind == "throw" else 0)
            if kind == "throw":
                assert fire.throw(who, amount, t), (name, night, who)
            elif kind == "kindle":
                assert fire.claim_kindling(who), (name, night, who)
            elif kind == "transfer":
                fire.transfer(who, other, amount)
            script.append((n, t, kind, who, other, amount))
        row = fire.settle()
        dust = 0
        if row["lit"]:
            dust = row["shared"] - sum(row["rewards"].values())
            # The contract divides by the sum of the windows' weights; the model by the sum of
            # the per-throw weights (each rounded down). The scenarios keep them equal.
            windows = {}
            for th in row["throws"]:
                windows.setdefault(th[4] * fire.windows // fire.night_ms, []).append(th[1])
            start, total = 0, 0
            for win in sorted(windows):
                x = sum(windows[win])
                below = max(0, min(x, row["target"] - start))
                two_t = 2 * row["target"]
                slice_w = below * (fire.em * two_t - (fire.em - sim.BPS) * (2 * start + below)) // two_t
                total += slice_w + (x - below) * fire.late
                start += x
            assert total == row["total_w"], (name, row["night"] + 1, "per-throw rounding", total - row["total_w"])
        rows.append((row["night"] + 1, "LIT" if row["lit"] else ("SMOKED" if row["pile"] else "COLD"),
                     row["target"], row["pile"], row["minted"], row["burned"], row["supply"],
                     row["hearth"], row["next_target"], row["streak"],
                     [fire.bal.get(a, 0) for a in accounts], dust))
    return cfg, accounts, script, rows


def rust(name, sc):
    cfg, accounts, script, rows = run(name, sc)
    up = name.upper()
    out = []
    out.append("pub const %s_FOUNDERS: &[(&str, u128)] = &[%s];" % (
        up, ", ".join('("%s", %d)' % (a, v * E) for a, v in sc["founders"].items())))
    out.append("pub const %s_ACCOUNTS: &[&str] = &[%s];" % (up, ", ".join('"%s"' % a for a in accounts)))
    out.append("pub const %s_SCRIPT: &[Step] = &[" % up)
    for (n, t, kind, who, other, amount) in script:
        out.append('    Step { night: %d, at_ms: %d, kind: "%s", who: "%s", other: "%s", amount: %d },'
                   % (n, t, kind, who, other, amount))
    out.append("];")
    out.append("pub const %s_NIGHTS: &[Night] = &[" % up)
    for (n, outcome, target, pile, minted, burned, supply, hearth, nxt, streak, bals, dust) in rows:
        out.append('    Night { night: %d, outcome: "%s", target: %d, pile: %d, minted: %d, burned: %d, supply: %d, '
                   'hearth: %d, next_target: %d, streak: %d, balances: &[%s], dust: %d },'
                   % (n, outcome, target, pile, minted, burned, supply, hearth, nxt, streak,
                      ", ".join(str(b) for b in bals), dust))
    out.append("];")
    return "\n".join(out)


if __name__ == "__main__":
    print("// generated by tests/golden_sim.py from sim/bonfire_sim.py (rule \"pooled\") and sim/params.json")
    print(rust("pooling", POOLING))
    print(rust("cap", CAP))
