#!/usr/bin/env python3
"""Bonfire: a 60-night simulation of community behaviour.

Standard library only. Every run is deterministic for its seed.

The model follows the contract's rules (DESIGN.md as revised, see
docs/SIMULATION.md): throws weighted by their place in the pile, pooled
windows, lit and smoke settlement, mint shares, the hearth cut and its capped
burn, kindling with a per-night cap, target growth, shrink and cap, streaks,
records and empty nights. DESIGN.md as written and the tested alternatives run
as comparison rule sets. Token amounts are integers in yoctoEMBER (18
decimals), every division rounds down, and conservation (supply = balances +
pile + hearth) is asserted after every night.

Commands:
  python3 sim/bonfire_sim.py all         sweep (writes sim/params.json), then scenarios,
                                         sensitivity, testnet, charts, document tables
  python3 sim/bonfire_sim.py scenarios   scenarios and charts with sim/params.json
  python3 sim/bonfire_sim.py sweep       parameter sweep and sensitivity only
  python3 sim/bonfire_sim.py testnet     testnet demo variant only
"""

import argparse
import json
import math
import os
import random
import statistics
import sys
from multiprocessing import Pool

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PARAMS_FILE = os.path.join(HERE, "params.json")
DOCS_SIM = os.path.join(ROOT, "docs", "sim")

UNIT = 10 ** 18          # yoctoEMBER per EMBER
BPS = 10_000             # basis points: 10,000 = 100 % = weight 1.0
NIGHTS = 60
SEEDS = list(range(1, 9))

# First guesses from DESIGN.md, in the units the simulation uses:
# EMBER amounts in whole EMBER, rates and weights in basis points.
# target_cap (basis points of the free supply, 0 = none) and min_throw (EMBER)
# are not in DESIGN.md; their first guesses come from the review of the rules.
DESIGN_GUESS = {
    "night_ms": 86_400_000,
    "genesis_supply": 1_000_000,
    "hearth_genesis": 400_000,
    "target_start": 20_000,
    "target_min": 5_000,
    "grow_pct": 500,
    "shrink_pct": 1000,
    "mint_pct": 500,
    "hearth_cut": 2000,
    "smoke_pct": 1000,
    "hearth_burn_pct": 100,
    "early_max": 15000,
    "late_lit": 5000,
    "kindling": 500,
    "kindling_per_night": 20,
    "max_catchup": 30,
    "log_keep": 14,
    "target_cap": 2500,
    "min_throw": 50,
    "pool_windows": 4,
    # used only by the warm rule sets, which are compared but not adopted
    "yield": 100,
    "mint_cap": 400,
}
# Highest early_max the contract accepts (config.rs, MAX_EARLY_BP).
CONTRACT_EARLY_MAX = 50_000

# Rule sets. "design" is DESIGN.md as written. "position" is the rule set the
# contract adopts after the review; "clock" is the same with the old clock
# weighting, to isolate the effect of weighting by pile position.
RULESETS = {
    "design": {"weight": "clock", "split": False, "empty_burn": True, "burn_cap": False,
               "target_cap": False},
    "clock": {"weight": "clock", "split": True, "empty_burn": False, "burn_cap": True,
              "target_cap": True},
    "position": {"weight": "position", "split": True, "empty_burn": False, "burn_cap": True,
                 "target_cap": True},
    # a proposal, not adopted: as "position", but all wood that lands in the same window
    # of the night (pool_windows windows a night) counts as landing together, pro rata
    "pooled": {"weight": "position", "split": True, "empty_burn": False, "burn_cap": True,
               "target_cap": True, "pooled": True},
    # "kindlers and warmers": wood below the target keeps the pile-position factor, wood above
    # it counts with factor 1.0, and a lit night pays every thrower yield * own weight,
    # scaled down pro rata only when the night's mint would exceed mint_cap * target
    "warm": {"weight": "position", "split": True, "empty_burn": False, "burn_cap": True,
             "target_cap": True, "warm": True},
    "warm_pooled": {"weight": "position", "split": True, "empty_burn": False, "burn_cap": True,
                    "target_cap": True, "warm": True, "pooled": True},
    # only the opening window is pooled; later wood keeps its exact place in the pile
    "opening": {"weight": "position", "split": True, "empty_burn": False, "burn_cap": True,
                "target_cap": True, "pooled": True, "opening_only": True},
}
MAIN_RULE = "pooled"
RULE_NAMES = {"design": "DESIGN.md as written", "clock": "clock weight, crossing split",
              "position": "pile-position weight", "pooled": "pile position, pooled windows",
              "warm": "kindlers and warmers", "warm_pooled": "warmers, pooled windows",
              "opening": "pile position, pooled opening window"}
POOL_WINDOWS = 4


# ---------------------------------------------------------------------------
# The contract model
# ---------------------------------------------------------------------------

class InvariantError(AssertionError):
    pass


class Fire:
    """Integer model of the contract's state machine.

    rule "design" (DESIGN.md as written):
      - a throw is weighted amount * early(t) by the clock, by the pile before
        it lands: a throw that crosses the target counts all its wood at
        early(t); wood on a pile that already reached the target gets late_lit;
      - every smoky or empty night burns hearth_burn_pct of the hearth;
      - the target has no cap.
    rule "position" (the rules after the review):
      - the part of a throw below the target is weighted by where it lands in
        the pile: the factor falls linearly from early_max (empty pile) to 1.0
        (pile at the target), integrated over the slice the throw covers;
        the part above the target gets late_lit;
      - an empty night (no wood) burns nothing from the hearth;
      - a smoky night burns min(hearth * hearth_burn_pct, target * mint_pct);
      - target_next = max(target_min, min(rule result, free supply * target_cap)),
        where free supply = supply - hearth - pile.
    rule "clock": as "position", but the part below the target is weighted by
      the clock, early(t).
    Throws below min_throw are refused in every rule set.
    """

    def __init__(self, prm, founders, rule=MAIN_RULE):
        rs = RULESETS[rule]
        self.prm = prm
        self.rule = rule
        self.night_ms = prm["night_ms"]
        self.em = prm["early_max"]
        self.late = prm["late_lit"]
        self.position = rs["weight"] == "position"
        self.split = rs["split"]
        self.empty_burn = rs["empty_burn"]
        self.burn_cap = rs["burn_cap"]
        self.target_cap = prm.get("target_cap", 0) if rs["target_cap"] else 0
        self.windows = prm.get("pool_windows", POOL_WINDOWS) if rs.get("pooled") else 0
        self.warm = bool(rs.get("warm"))
        self.opening_only = bool(rs.get("opening_only"))
        if self.warm:
            self.late = BPS       # warmers: wood above the target counts with factor 1.0
        self.capped_mints = 0
        self.min_throw = prm.get("min_throw", 0) * UNIT
        self.kindling_amount = prm["kindling"] * UNIT
        self.kindling_cap = prm["kindling_per_night"]
        self.bal = {}
        self.ever = set()
        total = 0
        for acct, amount in founders.items():
            self.bal[acct] = amount
            self.ever.add(acct)
            total += amount
        self.hearth = prm["hearth_genesis"] * UNIT
        self.supply = prm["genesis_supply"] * UNIT
        if total + self.hearth != self.supply:
            raise InvariantError("genesis does not add up")
        self.target = prm["target_start"] * UNIT
        self.target_min = prm["target_min"] * UNIT
        self.night = 0
        self.streak = 0
        self.longest = 0
        self.tallest = 0
        self.minted = 0
        self.burned = 0
        self.kindling_paid = 0
        self.capped_nights = 0
        self._open_night()

    def _open_night(self):
        self.pile = 0
        self.wood = {}
        self.weight = {}
        self.claims = 0
        self.throws = []

    def early_bps(self, t_ms):
        return self.em - (self.em - BPS) * t_ms // self.night_ms

    def slice_weight(self, before, below):
        """Weight of `below` units landing on a pile that holds `before`:
        the integral of the position factor over [before, before + below]."""
        two_t = 2 * self.target
        return below * (self.em * two_t - (self.em - BPS) * (2 * before + below)) // two_t

    def throw(self, acct, amount, t_ms):
        if amount <= 0 or amount < self.min_throw:
            return False
        have = self.bal.get(acct, 0)
        if amount > have:
            raise InvariantError("throw exceeds balance")
        if not 0 <= t_ms < self.night_ms:
            raise InvariantError("throw outside the night")
        self.bal[acct] = have - amount
        before = self.pile
        under = 0
        under_w = 0
        if before >= self.target:
            w = amount * self.late
            bucket = "after_lit"
        else:
            below = min(amount, self.target - before)
            above = amount - below
            if self.position:
                wb = self.slice_weight(before, below)
            else:
                wb = below * self.early_bps(t_ms)
            if above > 0 or below == self.target - before:
                bucket = "crossing"
                under, under_w = below, wb
            else:
                third = 3 * t_ms
                if third < self.night_ms:
                    bucket = "early"
                elif third < 2 * self.night_ms:
                    bucket = "middle"
                else:
                    bucket = "late"
            if self.split or self.position:
                w = wb + above * self.late
            else:
                w = amount * self.early_bps(t_ms)
        self.pile += amount
        self.wood[acct] = self.wood.get(acct, 0) + amount
        self.weight[acct] = self.weight.get(acct, 0) + w
        self.throws.append((acct, amount, w, bucket, t_ms, under, under_w))
        return True

    def claim_kindling(self, acct):
        if acct in self.ever:
            return False
        if self.claims >= self.kindling_cap or self.hearth < self.kindling_amount:
            return False
        self.hearth -= self.kindling_amount
        self.bal[acct] = self.bal.get(acct, 0) + self.kindling_amount
        self.ever.add(acct)
        self.claims += 1
        self.kindling_paid += self.kindling_amount
        return True

    def transfer(self, src, dst, amount):
        if amount <= 0:
            return
        if self.bal.get(src, 0) < amount:
            raise InvariantError("transfer exceeds balance")
        self.bal[src] -= amount
        self.bal[dst] = self.bal.get(dst, 0) + amount
        self.ever.add(dst)

    def _pool(self):
        """Pooled windows: every window's wood shares, pro rata, the slice of the
        pile it covers, as if it had all landed at once."""
        groups = {}
        for i, th in enumerate(self.throws):
            groups.setdefault(th[4] * self.windows // self.night_ms, []).append(i)
        pile = 0
        self.weight = {}
        out = list(self.throws)
        for win in sorted(groups):
            idx = groups[win]
            x = sum(self.throws[i][1] for i in idx)
            if self.opening_only and win > 0:
                # later wood keeps the weight of its exact place in the pile
                for i in idx:
                    acct, w = self.throws[i][0], self.throws[i][2]
                    self.weight[acct] = self.weight.get(acct, 0) + w
                pile += x
                continue
            below = max(0, min(x, self.target - pile))
            wsum = (self.slice_weight(pile, below) if below else 0) + (x - below) * self.late
            for i in idx:
                acct, amount, _, bucket, t_ms, under, _ = self.throws[i]
                w = wsum * amount // x
                self.weight[acct] = self.weight.get(acct, 0) + w
                out[i] = (acct, amount, w, bucket, t_ms, under, w * under // amount)
            pile += x
        self.throws = out

    def settle(self):
        prm = self.prm
        if self.windows and self.throws:
            self._pool()
        row = {"night": self.night, "target": self.target, "pile": self.pile,
               "throwers": len(self.wood), "rewards": {}, "losses": {}}
        if self.pile > 0 and self.pile >= self.target:
            for acct, wd in self.wood.items():
                self.bal[acct] += wd
            if self.warm:
                cap = self.target * prm["mint_cap"] // BPS
                mint = sum(self.weight.values()) * prm["yield"] // (BPS * BPS)
                if mint > cap:
                    mint = cap
                    self.capped_mints += 1
            else:
                mint = self.target * prm["mint_pct"] // BPS
            hearth_part = mint * prm["hearth_cut"] // BPS
            shared = mint - hearth_part
            total_w = sum(self.weight.values())
            paid = 0
            for acct, w in self.weight.items():
                share = shared * w // total_w
                if share:
                    self.bal[acct] += share
                    row["rewards"][acct] = share
                    paid += share
            self.hearth += hearth_part + (shared - paid)
            self.supply += mint
            self.minted += mint
            self.streak += 1
            self.longest = max(self.longest, self.streak)
            self.tallest = max(self.tallest, self.target)
            row.update(lit=True, minted=mint, burned=0, shared=shared, total_w=total_w)
            nxt = self.target * (BPS + prm["grow_pct"]) // BPS
        else:
            if self.pile == 0 and not self.empty_burn:
                hearth_burn = 0
            else:
                hearth_burn = self.hearth * prm["hearth_burn_pct"] // BPS
                if self.burn_cap:
                    most = prm["mint_cap"] if self.warm else prm["mint_pct"]
                    hearth_burn = min(hearth_burn, self.target * most // BPS)
            burn = self.pile * prm["smoke_pct"] // BPS
            back = self.pile - burn
            paid = 0
            for acct, wd in self.wood.items():
                refund = wd * back // self.pile
                self.bal[acct] += refund
                paid += refund
                row["losses"][acct] = wd - refund
            self.hearth += (back - paid) - hearth_burn
            self.supply -= burn + hearth_burn
            self.burned += burn + hearth_burn
            self.streak = 0
            row.update(lit=False, minted=0, burned=burn + hearth_burn,
                       pile_burn=burn, hearth_burn=hearth_burn)
            nxt = self.target * (BPS - prm["shrink_pct"]) // BPS
        row["throws"] = self.throws
        self.pile = 0
        if self.target_cap:
            cap = (self.supply - self.hearth - self.pile) * self.target_cap // BPS
            if cap < nxt:
                nxt = cap
                self.capped_nights += 1
        self.target = max(self.target_min, nxt)
        self.check()
        row.update(supply=self.supply, hearth=self.hearth, streak=self.streak,
                   next_target=self.target)
        self.night += 1
        self._open_night()
        return row

    def check(self):
        held = sum(self.bal.values())
        if self.supply != held + self.pile + self.hearth:
            raise InvariantError("conservation broken at night %d" % self.night)
        if self.hearth < 0 or min(self.bal.values() or [0]) < 0:
            raise InvariantError("negative balance at night %d" % self.night)
        if self.target < self.target_min:
            raise InvariantError("target below target_min")
        if self.supply != self.prm["genesis_supply"] * UNIT + self.minted - self.burned:
            raise InvariantError("supply does not match minted and burned")


# ---------------------------------------------------------------------------
# Behaviour models
# ---------------------------------------------------------------------------

# Each behaviour: its decision logic, the chance to be active on a night,
# when in the night it acts (fraction of the night) and which share of its
# balance it throws. Testnet bots throw a fixed size instead ("f" then
# scales that size).
BEHAVIOURS = {
    # throws a share of its balance early, most nights
    "loyal": {"logic": "plain", "p": 0.90, "t": (0.00, 0.25), "f": (0.20, 0.50)},
    # looks in mid-night; throws only if the streak is alive or the pile is close
    "fair_weather": {"logic": "fair", "p": 0.85, "t": (0.35, 0.85), "f": (0.15, 0.40),
                     "streak": 2, "close": 0.60},
    # looks in the last tenth; throws only if the fire is safe or its throw makes it safe
    "sniper": {"logic": "snipe", "p": 0.90, "t": (0.90, 0.995), "f": (0.30, 0.60),
               "close": 0.80},
    # large holder; throws a modest share on most nights, early to mid-night
    "whale": {"logic": "plain", "p": 0.60, "t": (0.05, 0.60), "f": (0.10, 0.30)},
    # large holder that snipes: one big throw at the very end
    "whale_sniper": {"logic": "snipe", "p": 0.80, "t": (0.95, 0.995), "f": (0.20, 0.40),
                     "close": 0.60},
    # never throws
    "free_rider": {"logic": "none", "p": 0.0},
    # a holder who covers the whole target alone in the first moment of every night
    "solo_lighter": {"logic": "solo", "p": 1.0, "t": (0.0, 0.0), "f": (1.0, 1.0)},
    # stress case: throws its whole balance every night, at a random moment
    "all_in": {"logic": "plain", "p": 1.0, "t": (0.0, 0.999), "f": (1.0, 1.0)},
    # testnet demo bots (fixed throw sizes, see TESTNET_BOTS)
    "bot_early": {"logic": "plain", "p": 0.90, "t": (0.00, 0.20), "f": (0.75, 1.25)},
    "bot_steady": {"logic": "fair", "p": 0.85, "t": (0.40, 0.80), "f": (0.75, 1.25),
                   "streak": 2, "close": 0.60},
    "bot_late": {"logic": "snipe", "p": 0.90, "t": (0.90, 0.99), "f": (1.00, 1.00),
                 "close": 0.80},
    "bot_idle": {"logic": "none", "p": 0.0},
    # a judge on testnet: throws a share of its kindling early in each night it plays
    "judge": {"logic": "plain", "p": 0.90, "t": (0.05, 0.60), "f": (0.30, 1.00)},
}


class Agent:
    __slots__ = ("name", "kind", "rng", "accounts", "newcomer", "joined", "left",
                 "thrown", "reward", "loss", "start", "fixed", "role")

    def __init__(self, name, kind, rng, accounts, newcomer=False, joined=0, role=None):
        self.name = name
        self.kind = kind
        self.rng = rng
        self.accounts = accounts
        self.newcomer = newcomer
        self.joined = joined
        self.left = None       # night from which the agent no longer plays
        self.thrown = 0
        self.reward = 0
        self.loss = 0
        self.start = 0
        self.fixed = None      # testnet bots: fixed throw size in yoctoEMBER
        self.role = role or kind


def plan_night(agent, decay):
    """Draw tonight's intention from the agent's own random stream.

    Every agent has its own stream, so one agent's choices never shift
    another agent's draws (this keeps the splitter comparison exact).
    """
    b = BEHAVIOURS[agent.kind]
    if b["logic"] == "none":
        return None
    r = agent.rng
    if r.random() >= b["p"] * decay:
        return None
    t = r.uniform(*b["t"])
    f = r.uniform(*b["f"])
    return t, int(f * BPS)


def act(agent, fire, t_ms, f_bps, record=True):
    """Decide once for the whole agent (all its accounts) and throw.

    An agent that holds several accounts (the splitter) throws the same
    total wood at the same moment, spread over its accounts in proportion
    to their balances.
    """
    b = BEHAVIOURS[agent.kind]
    logic = b["logic"]
    if logic == "fair":
        close = fire.pile * BPS >= int(b["close"] * BPS) * fire.target
        if not (fire.streak >= b["streak"] or close):
            return 0
    have = sum(fire.bal.get(a, 0) for a in agent.accounts)
    if logic == "solo":
        gap = fire.target - fire.pile
        if gap <= 0 or have < gap:
            return 0
        if fire.throw(agent.accounts[0], gap, t_ms):
            if record:
                agent.thrown += gap
            return gap
        return 0
    if agent.fixed is not None:
        amount = min(have, agent.fixed * f_bps // BPS)
    else:
        amount = have * f_bps // BPS
    if amount <= 0:
        return 0
    if logic == "snipe":
        # A sniper never risks smoke: it throws only onto a fire that is
        # already safe, or with a throw that makes it safe on its own. It
        # sizes the throw greedily for the rule in force: under the rule as
        # written all of a crossing throw counts at early(t), so it throws
        # as much as it planned; under the split rule wood above the target
        # earns late_lit, so with late_lit = 0 it throws exactly the gap.
        if fire.pile >= fire.target:
            if fire.late == 0:
                return 0
        else:
            near = fire.pile * BPS >= int(b["close"] * BPS) * fire.target
            gap = fire.target - fire.pile
            if not near or amount < gap:
                return 0
            if fire.split and fire.late == 0:
                amount = gap
    total = 0
    if len(agent.accounts) == 1:
        if fire.throw(agent.accounts[0], amount, t_ms):
            total = amount
    else:
        parts = [amount * fire.bal.get(a, 0) // have for a in agent.accounts]
        # the rounding remainder goes to the largest account, so the pieces add up exactly
        big = max(range(len(parts)), key=lambda i: fire.bal.get(agent.accounts[i], 0))
        parts[big] += amount - sum(parts)
        for a, part in zip(agent.accounts, parts):
            if part > 0 and fire.throw(a, part, t_ms):
                total += part
    if record:
        agent.thrown += total
    return total


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

HEALTHY_GROUPS = [("loyal", 60, 0.30), ("fair_weather", 80, 0.25), ("sniper", 15, 0.07),
                  ("free_rider", 100, 0.23), ("whale", 2, 0.15)]
HEALTHY_MIX = [("loyal", 0.35), ("fair_weather", 0.35), ("sniper", 0.10), ("free_rider", 0.20)]

SCENARIOS = {
    "healthy": {
        "title": "Healthy community",
        "groups": HEALTHY_GROUPS, "arrivals": 4.0, "mix": HEALTHY_MIX,
    },
    "fading": {
        "title": "Fading community",
        "groups": HEALTHY_GROUPS, "arrivals": 4.0, "mix": HEALTHY_MIX, "decay": 20.0,
    },
    "whale": {
        "title": "Whale-dominated",
        "groups": [("loyal", 20, 0.06), ("fair_weather", 30, 0.06), ("sniper", 5, 0.02),
                   ("free_rider", 40, 0.06), ("whale", 2, 0.50), ("whale_sniper", 1, 0.30)],
        "arrivals": 2.0, "mix": HEALTHY_MIX,
    },
    "sniper": {
        "title": "Sniper-heavy",
        "groups": [("loyal", 25, 0.10), ("fair_weather", 35, 0.12), ("sniper", 120, 0.45),
                   ("free_rider", 60, 0.23), ("whale", 2, 0.10)],
        "arrivals": 4.0,
        "mix": [("loyal", 0.15), ("fair_weather", 0.20), ("sniper", 0.50), ("free_rider", 0.15)],
    },
    "free_rider": {
        "title": "Free-rider-heavy",
        "groups": [("loyal", 20, 0.08), ("fair_weather", 25, 0.08), ("sniper", 5, 0.02),
                   ("free_rider", 250, 0.75), ("whale", 1, 0.07)],
        "arrivals": 4.0,
        "mix": [("loyal", 0.10), ("fair_weather", 0.15), ("sniper", 0.05), ("free_rider", 0.70)],
    },
    "solo": {
        "title": "Opening-bell solo lighter",
        # listed first, so at the opening bell its throw lands before anyone else's
        "groups": [("solo_lighter", 1, 0.20), ("loyal", 60, 0.24), ("fair_weather", 80, 0.20),
                   ("sniper", 15, 0.056), ("free_rider", 100, 0.184), ("whale", 2, 0.12)],
        "arrivals": 4.0, "mix": HEALTHY_MIX,
    },
    "all_in": {
        "title": "Everyone throws everything",
        "groups": [("all_in", 277, 1.0)], "arrivals": 4.0, "mix": [("all_in", 1.0)],
    },
    "farm": {
        "title": "Sybil kindling farm",
        "groups": HEALTHY_GROUPS, "arrivals": 4.0, "mix": HEALTHY_MIX, "farm": True,
    },
    "splitter": {
        "title": "Sybil splitter",
        "groups": HEALTHY_GROUPS, "arrivals": 4.0, "mix": HEALTHY_MIX,
        "splitter": {"kind": "loyal", "share": 0.03, "accounts": 64},
    },
    # used only by the splitter test: the split entity completes the fire
    "splitter_sniper": {
        "title": "Sybil splitter (sniper)",
        "groups": HEALTHY_GROUPS, "arrivals": 4.0, "mix": HEALTHY_MIX,
        "splitter": {"kind": "sniper", "share": 0.03, "accounts": 64},
    },
}
SCENARIO_ORDER = ["healthy", "fading", "whale", "sniper", "free_rider", "solo", "all_in",
                  "farm", "splitter"]
STRESS = ("all_in",)


def founder_balances(groups, founder_total, rng):
    """Lognormal balances, scaled so each group holds its share exactly."""
    out = []
    total_share = sum(g[2] for g in groups)
    for kind, count, share in groups:
        raw = [rng.lognormvariate(0.0, 0.8) for _ in range(count)]
        s = sum(raw)
        group_total = founder_total * int(share / total_share * 1_000_000) // 1_000_000
        bals = [group_total * int(x / s * 1_000_000) // 1_000_000 for x in raw]
        out.append((kind, bals))
    return out


def build_population(spec, prm, seed, split_accounts=None):
    rng = random.Random("%d:population" % seed)
    founder_total = (prm["genesis_supply"] - prm["hearth_genesis"]) * UNIT
    groups = list(spec["groups"])
    splitter = spec.get("splitter")
    if splitter:
        # the splitter's balance is taken out of its behaviour group
        groups = [(k, c, s - splitter["share"] if k == splitter["kind"] else s)
                  for k, c, s in groups] + [("splitter", 1, splitter["share"])]
    agents = []
    founders = {}
    for kind, bals in founder_balances(groups, founder_total, rng):
        for i, bal in enumerate(bals):
            name = "%s-%d" % (kind, i)
            if kind == "splitter":
                k = split_accounts or splitter["accounts"]
                accts = ["%s.%d" % (name, j) for j in range(k)]
                part = bal // k
                for j, a in enumerate(accts):
                    founders[a] = part + (bal - part * k if j == 0 else 0)
                agents.append(Agent(name, splitter["kind"], random.Random("%d:%s" % (seed, name)),
                                    accts, role="splitter"))
            else:
                founders[name] = bal
                agents.append(Agent(name, kind, random.Random("%d:%s" % (seed, name)), [name]))
    # rounding remainder of the founder allocation goes to the first account
    rest = founder_total - sum(founders.values())
    first = agents[0].accounts[0]
    founders[first] += rest
    return agents, founders


def pick(mix, x):
    acc = 0.0
    for kind, w in mix:
        acc += w
        if x < acc:
            return kind
    return mix[-1][0]


def run(prm, scenario, seed, rule=MAIN_RULE, split_accounts=None,
        nights=NIGHTS, keep_rows=False):
    spec = SCENARIOS[scenario]
    agents, founders = build_population(spec, prm, seed, split_accounts)
    fire = Fire(prm, founders, rule)
    by_acct = {}
    for a in agents:
        for acct in a.accounts:
            by_acct[acct] = a
        a.start = sum(founders[x] for x in a.accounts)
    free_start = sum(a.start for a in agents if a.kind == "free_rider" and not a.newcomer)
    arrivals_rng = random.Random("%d:arrivals" % seed)
    farm_main = None
    farm_accounts = 0
    if spec.get("farm"):
        farm_main = Agent("farm-main", "loyal", random.Random("%d:farm" % seed),
                          ["farm-main"], role="farm")
        fire.bal["farm-main"] = 0
        agents.append(farm_main)
        by_acct["farm-main"] = farm_main
    decay_tau = spec.get("decay")
    newcomers_seen = newcomers_kindled = 0
    buckets = {}
    kind_buckets = {}
    shared_total = riskless = 0.0
    series = {"supply": [], "target": [], "pile": [], "lit": [], "hearth": [], "streak": []}
    rows = []
    n_new = 0
    for night in range(nights):
        decay = math.exp(-night / decay_tau) if decay_tau else 1.0
        events = []
        seq = 0
        # the farm is a bot: it claims every kindling slot in the first block
        if farm_main is not None:
            while True:
                acct = "farm-%d-%d" % (night, fire.claims)
                if not fire.claim_kindling(acct):
                    break
                farm_accounts += 1
                fire.transfer(acct, "farm-main", fire.bal[acct])
                del fire.bal[acct]
        # newcomers arrive during the night, claim kindling and play from tomorrow
        lam = spec["arrivals"] * decay
        k_new = poisson(arrivals_rng, lam)
        arrivals = sorted(arrivals_rng.random() for _ in range(k_new))
        kinds = [pick(spec["mix"], arrivals_rng.random()) for _ in range(k_new)]
        for agent in agents:
            if agent.joined > night:
                continue
            intent = plan_night(agent, decay)
            if intent is None:
                continue
            t, f_bps = intent
            events.append((int(t * prm["night_ms"]), seq, agent, f_bps))
            seq += 1
        for t, kind in zip(arrivals, kinds):
            events.append((int(t * prm["night_ms"]), seq, ("new", kind), 0))
            seq += 1
        events.sort(key=lambda e: (e[0], e[1]))
        for t_ms, _, who, f_bps in events:
            if isinstance(who, tuple):
                newcomers_seen += 1
                name = "new-%d" % n_new
                n_new += 1
                if fire.claim_kindling(name):
                    newcomers_kindled += 1
                    ag = Agent(name, who[1], random.Random("%d:%s" % (seed, name)), [name],
                               newcomer=True, joined=night + 1)
                    ag.start = fire.bal[name]
                    agents.append(ag)
                    by_acct[name] = ag
                continue
            act(who, fire, t_ms, f_bps)
        row = fire.settle()
        # attribute the night's outcome to agents and to timing buckets
        for acct, share in row["rewards"].items():
            by_acct[acct].reward += share
        for acct, lost in row["losses"].items():
            by_acct[acct].loss += lost
        if row["lit"]:
            shared_total += row["shared"] / UNIT
        for acct, amount, w, bucket, t_ms, under, under_w in row["throws"]:
            bk = buckets.setdefault(bucket, [0.0, 0.0])
            kb = kind_buckets.setdefault((by_acct[acct].kind, bucket), [0.0, 0.0])
            if row["lit"]:
                gain = row["shared"] / UNIT * w / row["total_w"]
            else:
                gain = -amount / UNIT * prm["smoke_pct"] / BPS
            bk[0] += amount / UNIT
            bk[1] += gain
            kb[0] += amount / UNIT
            kb[1] += gain
            if bucket == "after_lit":
                riskless += gain
            if bucket == "crossing":
                # best case for a sniper: only the wood that closes the gap
                gp = buckets.setdefault("gap", [0.0, 0.0])
                gp[0] += under / UNIT
                gp[1] += row["shared"] / UNIT * under_w / row["total_w"]
        series["supply"].append(row["supply"] / UNIT)
        series["target"].append(row["target"] / UNIT)
        series["pile"].append(row["pile"] / UNIT)
        series["lit"].append(row["lit"])
        series["hearth"].append(row["hearth"] / UNIT)
        series["streak"].append(row["streak"])
        if keep_rows:
            rows.append({k: v for k, v in row.items() if k not in ("throws", "rewards", "losses")})
    # per-behaviour totals
    kinds = {}
    for a in agents:
        key = a.role if a.role in ("farm", "splitter") else a.kind
        k = kinds.setdefault(key, {"thrown": 0, "reward": 0, "loss": 0, "start": 0,
                                   "end": 0, "count": 0})
        k["thrown"] += a.thrown
        k["reward"] += a.reward
        k["loss"] += a.loss
        k["start"] += a.start
        k["end"] += sum(fire.bal.get(x, 0) for x in a.accounts)
        k["count"] += 1
    free_end = sum(sum(fire.bal.get(x, 0) for x in a.accounts)
                   for a in agents if a.kind == "free_rider" and not a.newcomer)
    genesis = prm["genesis_supply"] * UNIT
    out = {
        "scenario": scenario, "seed": seed, "rule": rule,
        "capped_nights": fire.capped_nights,
        "capped_mints": fire.capped_mints,
        "shared_total": shared_total,
        "series": series,
        "lit_rate": sum(series["lit"]) / nights,
        "longest": fire.longest,
        "tallest": fire.tallest / UNIT,
        "minted": fire.minted / UNIT,
        "burned": fire.burned / UNIT,
        "supply_end": fire.supply / UNIT,
        "supply_ratio": fire.supply / genesis,
        "supply_min_ratio": min(series["supply"]) * UNIT / genesis,
        "supply_max_ratio": max(series["supply"]) * UNIT / genesis,
        "hearth_end": fire.hearth / UNIT,
        "kinds": kinds,
        "buckets": buckets,
        "kind_buckets": kind_buckets,
        "riskless_share": riskless / shared_total if shared_total else 0.0,
        "free_share_start": free_start / genesis,
        "free_share_end": free_end / fire.supply,
        "kindling_paid": fire.kindling_paid / UNIT,
        "newcomers_seen": newcomers_seen,
        "newcomers_kindled": newcomers_kindled,
        "farm_accounts": farm_accounts,
        "farm_haul": (farm_accounts * prm["kindling"]),
        "smoke_nights": nights - sum(series["lit"]),
    }
    if spec.get("splitter"):
        sp = [a for a in agents if a.role == "splitter"][0]
        out["splitter"] = {"accounts": len(sp.accounts), "start": sp.start,
                           "end": sum(fire.bal.get(x, 0) for x in sp.accounts),
                           "reward": sp.reward, "loss": sp.loss, "thrown": sp.thrown}
    if keep_rows:
        out["rows"] = rows
    return out


def poisson(rng, lam):
    if lam <= 0:
        return 0
    limit = math.exp(-lam)
    k, p = 0, 1.0
    while True:
        p *= rng.random()
        if p <= limit:
            return k
        k += 1


# ---------------------------------------------------------------------------
# Aggregation helpers
# ---------------------------------------------------------------------------

def net_per_ember(k):
    """Net reward per EMBER thrown: (mint received - wood burned) / wood thrown."""
    if k["thrown"] == 0:
        return None
    return (k["reward"] - k["loss"]) / k["thrown"]


def med(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None




def summarize(r):
    """Reduce one run to the numbers the sweep and the report need."""
    k = r["kinds"]

    def npe(name):
        v = k.get(name)
        return net_per_ember(v) if v and v["thrown"] else None

    def bpe(name):
        v = r["buckets"].get(name)
        return v[1] / v[0] if v and v[0] > 0 else None

    keys = ("scenario", "seed", "rule", "lit_rate", "longest", "tallest", "minted",
            "burned", "supply_end", "supply_ratio", "supply_min_ratio", "supply_max_ratio",
            "hearth_end", "kindling_paid", "newcomers_seen", "newcomers_kindled",
            "farm_haul", "smoke_nights")
    s = {key: r[key] for key in keys}
    for name in ("loyal", "fair_weather", "sniper", "whale", "whale_sniper", "farm",
                 "solo_lighter"):
        s["npe_" + name] = npe(name)
    solo = k.get("solo_lighter")
    s["solo_share"] = (solo["reward"] / UNIT / r["shared_total"]
                       if solo and r["shared_total"] else None)
    s["capped_nights"] = r["capped_nights"]
    s["capped_mints"] = r["capped_mints"]
    for name in ("early", "middle", "late", "crossing", "gap", "after_lit"):
        s["b_" + name] = bpe(name)
    for kind in ("sniper", "whale_sniper"):
        for bucket, label in (("crossing", "complete"), ("after_lit", "pile")):
            v = r["kind_buckets"].get((kind, bucket))
            s["npe_%s_%s" % (kind, label)] = v[1] / v[0] if v and v[0] > 0 else None
    s["riskless_share"] = r["riskless_share"]
    fs = r["free_share_start"]
    s["free_delta"] = r["free_share_end"] / fs - 1 if fs else None
    s["hearth_min"] = min(r["series"]["hearth"])
    s["kindled_rate"] = (r["newcomers_kindled"] / r["newcomers_seen"]
                         if r["newcomers_seen"] else None)
    if "splitter" in r:
        s["splitter"] = r["splitter"]
    return s


def _task(args):
    prm, scenario, seed, rule = args
    return summarize(run(prm, scenario, seed, rule))


def _task_full(args):
    prm, scenario, seed, rule = args
    return run(prm, scenario, seed, rule, keep_rows=(scenario == "healthy" and seed == 1))


def aggregate(summaries):
    """Medians across seeds per scenario, plus worst cases for the supply band."""
    by = {}
    for s in summaries:
        by.setdefault(s["scenario"], []).append(s)
    agg = {}
    for sc, lst in by.items():
        a = {"n": len(lst)}
        for key, v0 in lst[0].items():
            if key in ("scenario", "seed", "rule", "splitter"):
                continue
            a[key] = med([x[key] for x in lst])
        a["supply_min_worst"] = min(x["supply_min_ratio"] for x in lst)
        a["supply_max_worst"] = max(x["supply_max_ratio"] for x in lst)
        a["supply_ratio_lo"] = min(x["supply_ratio"] for x in lst)
        a["supply_ratio_hi"] = max(x["supply_ratio"] for x in lst)
        a["lit_lo"] = min(x["lit_rate"] for x in lst)
        a["lit_hi"] = max(x["lit_rate"] for x in lst)
        a["hearth_min_worst"] = min(x["hearth_min"] for x in lst)
        agg[sc] = a
    return agg


# ---------------------------------------------------------------------------
# Criteria for the launch parameters
# ---------------------------------------------------------------------------

# Acceptance thresholds (the task) and stricter selection thresholds, so the
# pick does not sit on an edge that a different seed would cross.
ACCEPT = {"lit": (0.60, 0.85), "streak": 7, "smoke": 6, "healthy_supply": (1.00, 1.30),
          "band": (0.80, 1.40), "early_edge": 1.5, "free_loss": 0.0,
          "farm_keep": 0.60, "kindled": 0.90, "solo_share": 0.75, "solo_community": 0.005}
SELECT = {"lit": (0.65, 0.80), "streak": 7, "smoke": 8, "healthy_supply": (1.03, 1.25),
          "band": (0.85, 1.35), "early_edge": 1.75, "free_loss": 0.02,
          "farm_keep": 0.65, "kindled": 0.92, "solo_share": 0.70, "solo_community": 0.0075}


def edge(a):
    """Early wood (loyal) over the best riskless or late wood, all as net reward
    per EMBER thrown: the sniper's completing throws, the sniper's wood piled
    onto a safe fire, and any wood thrown onto a safe fire (warming). The best
    of these counts."""
    lo = a.get("npe_loyal")
    sn = [v for v in (a.get("npe_sniper_complete"), a.get("npe_sniper_pile"),
                      a.get("b_after_lit")) if v is not None]
    if lo is None or not sn:
        return None
    best = max(sn)
    if best <= 0:
        return float("inf") if lo > 0 else 0.0
    return lo / best


def criteria(agg, th=ACCEPT, tags=None):
    """Return [(name, ok, detail)] for every criterion whose scenarios were
    run. tags limits the check to some groups: fire, supply, edge, free,
    farm."""
    out = []

    def want(tag):
        return tags is None or tag in tags

    h = agg.get("healthy")
    if h and want("fire"):
        lo, hi = th["lit"]
        out.append(("healthy fire lit %d-%d %% of nights" % (lo * 100, hi * 100),
                    lo <= h["lit_rate"] <= hi, "%.0f %%" % (h["lit_rate"] * 100)))
        out.append(("healthy fire has streaks (>= %d) and smoke (>= %d nights)"
                    % (th["streak"], th["smoke"]),
                    h["longest"] >= th["streak"] and h["smoke_nights"] >= th["smoke"],
                    "streak %d, smoke %d" % (h["longest"], h["smoke_nights"])))
    if want("supply"):
        if h:
            lo, hi = th["healthy_supply"]
            out.append(("healthy supply grows modestly (%.2f-%.2f x genesis)" % (lo, hi),
                        lo < h["supply_ratio"] <= hi, "%.3f x" % h["supply_ratio"]))
        lo, hi = th["band"]
        worst_lo = min(a["supply_min_worst"] for a in agg.values())
        worst_hi = max(a["supply_max_worst"] for a in agg.values())
        out.append(("no scenario leaves %.2f-%.2f x genesis on any night" % (lo, hi),
                    worst_lo >= lo and worst_hi <= hi, "%.3f-%.3f x" % (worst_lo, worst_hi)))
    if want("edge"):
        for sc in ("healthy", "sniper"):
            a = agg.get(sc)
            if a:
                e = edge(a)
                ok = e is not None and e >= th["early_edge"] and a["npe_loyal"] > 0
                out.append(("%s: early wood earns >= %.2f x sniping per EMBER"
                            % (sc, th["early_edge"]), ok, fmt_edge(e, "x")))
        a = agg.get("solo")
        if a and a.get("solo_share") is not None:
            out.append(("solo lighter takes <= %d %% of the throwers' mint" % (th["solo_share"] * 100),
                        a["solo_share"] <= th["solo_share"], "%.0f %%" % (a["solo_share"] * 100)))
            out.append(("early wood beside a solo lighter earns >= %.2f %% per EMBER"
                        % (th["solo_community"] * 100),
                        a["npe_loyal"] >= th["solo_community"], pct(a["npe_loyal"], 2, True)))
    if want("free"):
        for sc in ("healthy", "sniper", "free_rider"):
            a = agg.get(sc)
            if a and a.get("free_delta") is not None:
                out.append(("%s: free riders lose share" % sc,
                            a["free_delta"] < -th["free_loss"],
                            "%+.1f %%" % (a["free_delta"] * 100)))
    if want("farm"):
        if h and h.get("kindled_rate") is not None:
            out.append(("newcomers get kindling (>= %d %%)" % (th["kindled"] * 100),
                        h["kindled_rate"] >= th["kindled"],
                        "%.0f %%" % (h["kindled_rate"] * 100)))
        f = agg.get("farm")
        if f and h:
            keep = f["hearth_end"] / h["hearth_end"] if h["hearth_end"] else 0
            out.append(("sybil farm only drains the hearth slowly (keeps >= %d %%)"
                        % (th["farm_keep"] * 100),
                        keep >= th["farm_keep"] and f["hearth_min_worst"] > 0,
                        "%.0f %% of the hearth without a farm" % (keep * 100)))
    return out


def fmt_edge(e, unit=""):
    if e is None:
        return "n/a"
    if e == float("inf"):
        return "sniping <= 0"
    return "%.2f%s" % (e, (" " + unit) if unit else "")


# ---------------------------------------------------------------------------
# Parameter sweep
# ---------------------------------------------------------------------------

SWEEP_GRID = {
    "grow_pct": [500, 700, 1000],
    "shrink_pct": [800, 1000, 1500],
    "target_start": [20_000, 35_000, 50_000],
    "target_cap": [1000, 2500, 5000],
    "mint_pct": [300, 400, 500],
    "smoke_pct": [100, 200, 300, 500],
    "early_max": [15000, 30000, 40000, 50000, 60000],
    "late_lit": [0, 1000, 2500],
    "hearth_cut": [1000, 2000, 3000],
    "hearth_burn_pct": [25, 50, 100],
    "kindling": [100, 250, 500],
    "kindling_per_night": [5, 10, 20],
}
# title, knobs, scenarios, criteria groups
STAGES = [
    ("A: fire dynamics", ["grow_pct", "shrink_pct", "target_start", "target_cap"],
     ["healthy", "fading", "free_rider", "solo", "all_in"], ["fire", "supply"]),
    ("B: rewards and burns", ["mint_pct", "smoke_pct", "early_max", "late_lit"],
     ["healthy", "sniper", "fading", "free_rider", "solo", "all_in"],
     ["fire", "supply", "edge", "free"]),
    ("C: hearth and kindling", ["hearth_cut", "hearth_burn_pct", "kindling", "kindling_per_night"],
     ["healthy", "farm", "fading", "free_rider"], ["supply", "free", "farm"]),
]
SWEEP_SEEDS = [1, 2]
SWEEP_RULE = MAIN_RULE
SWEEP_ROUNDS = 4


def grid_distance(prm):
    """Grid steps away from the first guess, summed over the swept knobs."""
    d = 0
    for key, values in SWEEP_GRID.items():
        vals = sorted(set(values) | {DESIGN_GUESS[key], prm[key]})
        d += abs(vals.index(prm[key]) - vals.index(DESIGN_GUESS[key]))
    return d


def log_distance(prm):
    """Tie-break between equal grid distances: relative change from the first guess."""
    return sum(abs(math.log((prm[k] + 1) / (DESIGN_GUESS[k] + 1))) for k in SWEEP_GRID)


def combos(keys):
    out = [{}]
    for key in keys:
        out = [dict(c, **{key: v}) for c in out for v in SWEEP_GRID[key]]
    return out


def run_many(tasks, workers, fn=_task):
    if workers <= 1:
        return [fn(t) for t in tasks]
    with Pool(workers) as pool:
        return pool.map(fn, tasks, chunksize=8)


def sweep(base, workers, log=print, rounds=SWEEP_ROUNDS):
    """Staged sweep (coordinate search): each stage varies a group of knobs
    over a grid, keeps the other knobs at their current pick, and picks the
    combination that passes the stage's criteria with the stricter selection
    margins and is the fewest grid steps away from the DESIGN.md first guess.
    The stages repeat until a round changes nothing (at most `rounds`)."""
    pick = dict(base)
    report = []
    history = []
    for rnd in range(1, rounds + 1):
        before = dict(pick)
        pick, report = _sweep_round(pick, workers, log, rnd)
        history.append({k: pick[k] for k in SWEEP_GRID})
        if pick == before:
            log("sweep round %d changed nothing; stopping" % rnd)
            break
    return pick, report, history


def _sweep_round(pick, workers, log, rnd):
    pick = dict(pick)
    report = []
    for title, keys, scenarios, tags in STAGES:
        cands = combos(keys)
        tasks = [(dict(pick, **c), sc, seed, SWEEP_RULE)
                 for c in cands for sc in scenarios for seed in SWEEP_SEEDS]
        log("sweep round %d, stage %s: %d combinations, %d runs"
            % (rnd, title, len(cands), len(tasks)))
        res = run_many(tasks, workers)
        per = len(scenarios) * len(SWEEP_SEEDS)
        rows = []
        for ci, c in enumerate(cands):
            agg = aggregate(res[ci * per:(ci + 1) * per])
            sel = criteria(agg, SELECT, tags)
            acc = criteria(agg, ACCEPT, tags)
            over = dict(pick, **c)["early_max"] > CONTRACT_EARLY_MAX
            rows.append({"combo": c, "agg": agg,
                         "fails_sel": sum(1 for _, ok, _ in sel if not ok) + over,
                         "fails_acc": sum(1 for _, ok, _ in acc if not ok) + over,
                         "failed": [n for n, ok, _ in acc if not ok]
                         + (["early_max above the contract's limit"] if over else []),
                         "dist": grid_distance(dict(pick, **c)),
                         "logdist": log_distance(dict(pick, **c))})
        rows.sort(key=lambda r: (r["fails_sel"], r["fails_acc"], r["dist"], r["logdist"]))
        best = rows[0]
        pick.update(best["combo"])
        n_pass = sum(1 for r in rows if r["fails_acc"] == 0)
        n_sel = sum(1 for r in rows if r["fails_sel"] == 0)
        log("  pick %s (selection fails %d, acceptance fails %d, %d grid steps from the "
            "first guess; %d of %d pass acceptance, %d pass selection)"
            % (best["combo"], best["fails_sel"], best["fails_acc"], best["dist"],
               n_pass, len(rows), n_sel))
        report.append({"title": title, "keys": keys, "scenarios": scenarios, "tags": tags,
                       "rows": rows, "pick": dict(best["combo"]), "n_pass": n_pass,
                       "n_sel": n_sel, "n": len(rows)})
    return pick, report


def sensitivity(pick, workers, rule=MAIN_RULE):
    """One knob at a time, one grid step down and up from the pick."""
    scen = [s for s in SCENARIO_ORDER if s != "splitter"]
    variants = [("launch", None, None)]
    for key, values in SWEEP_GRID.items():
        lower = [v for v in values if v < pick[key]]
        higher = [v for v in values if v > pick[key]]
        if lower:
            variants.append((key, lower[-1], "down"))
        if higher:
            variants.append((key, higher[0], "up"))
    tasks = []
    for key, v, _ in variants:
        prm = dict(pick)
        if key != "launch":
            prm[key] = v
        for sc in scen:
            for seed in SWEEP_SEEDS:
                tasks.append((prm, sc, seed, rule))
    res = run_many(tasks, workers)
    per = len(scen) * len(SWEEP_SEEDS)
    out = []
    for vi, (key, v, d) in enumerate(variants):
        agg = aggregate(res[vi * per:(vi + 1) * per])
        out.append({"key": key, "value": v, "dir": d, "agg": agg,
                    "crit": criteria(agg, ACCEPT)})
    return out


# ---------------------------------------------------------------------------
# Testnet demo variant
# ---------------------------------------------------------------------------

# name, behaviour, founding balance (EMBER), throw size (EMBER)
TESTNET_BOTS = [
    ("demo-bot-early-a", "bot_early", 40_000, 200),
    ("demo-bot-early-b", "bot_early", 30_000, 150),
    ("demo-bot-steady", "bot_steady", 15_000, 150),
    ("demo-bot-late", "bot_late", 5_000, 100),
    ("demo-bot-idle", "bot_idle", 10_000, 0),
]
TESTNET_DAYS = 14
TESTNET_JUDGES = 24


def run_testnet(prm, seed, judges=TESTNET_JUDGES, rule=MAIN_RULE, days=TESTNET_DAYS):
    import copy
    nights = days * 86_400_000 // prm["night_ms"]
    founders = {name: bal * UNIT for name, _, bal, _ in TESTNET_BOTS}
    fire = Fire(prm, founders, rule)
    agents = []
    for name, kind, bal, size in TESTNET_BOTS:
        a = Agent(name, kind, random.Random("%d:%s" % (seed, name)), [name])
        a.fixed = size * UNIT
        a.start = founders[name]
        agents.append(a)
    by_acct = {a.accounts[0]: a for a in agents}
    jr = random.Random("%d:judges" % seed)
    schedule = sorted((jr.randrange(nights - 24), jr.randint(6, 18)) for _ in range(judges))
    judge_agents = []
    pivotal = judge_nights = 0
    judge_mint_share = []
    waiting = []
    series = {"supply": [], "target": [], "pile": [], "lit": [], "hearth": []}
    for night in range(nights):
        for i, (start, length) in enumerate(schedule):
            if start <= night < start + length and i not in waiting and \
                    not any(j.name == "judge-%d" % i for j in judge_agents):
                waiting.append(i)
        for i in list(waiting):
            start, length = schedule[i]
            if night >= start + length:
                waiting.remove(i)
                continue
            name = "judge-%d" % i
            if fire.claim_kindling(name):
                waiting.remove(i)
                j = Agent(name, "judge", random.Random("%d:%s" % (seed, name)), [name],
                          joined=night)
                j.left = start + length
                j.start = fire.bal[name]
                agents.append(j)
                judge_agents.append(j)
                by_acct[name] = j
        events = []
        for seq, a in enumerate(agents):
            if a.joined > night or (a.left is not None and night >= a.left):
                continue
            intent = plan_night(a, 1.0)
            if intent is None:
                continue
            t, f_bps = intent
            events.append((int(t * prm["night_ms"]), seq, a, f_bps))
        events.sort(key=lambda e: (e[0], e[1]))
        judge_on = any(e[2].kind == "judge" for e in events)
        if judge_on:
            cf = copy.deepcopy(fire)
            for t_ms, _, a, f_bps in events:
                if a.kind != "judge":
                    act(a, cf, t_ms, f_bps, record=False)
            cf_lit = cf.pile >= cf.target
        for t_ms, _, a, f_bps in events:
            act(a, fire, t_ms, f_bps)
        row = fire.settle()
        for acct, share in row["rewards"].items():
            by_acct[acct].reward += share
        for acct, lost in row["losses"].items():
            by_acct[acct].loss += lost
        if judge_on:
            judge_nights += 1
            if row["lit"] != cf_lit:
                pivotal += 1
            if row["lit"]:
                js = sum(v for k, v in row["rewards"].items() if k.startswith("judge-"))
                judge_mint_share.append(js / row["shared"])
        series["supply"].append(row["supply"] / UNIT)
        series["target"].append(row["target"] / UNIT)
        series["pile"].append(row["pile"] / UNIT)
        series["lit"].append(row["lit"])
        series["hearth"].append(row["hearth"] / UNIT)
    tg = sorted(series["target"])
    day = 86_400_000 // prm["night_ms"]
    jn = [net_per_ember({"thrown": j.thrown, "reward": j.reward, "loss": j.loss})
          for j in judge_agents if j.thrown]
    jend = [sum(fire.bal.get(x, 0) for x in j.accounts) / j.start for j in judge_agents]
    bots = {}
    for a in agents:
        if a.kind.startswith("bot_"):
            bots[a.name] = {"npe": net_per_ember({"thrown": a.thrown, "reward": a.reward,
                                                  "loss": a.loss}),
                            "end_over_start": fire.bal[a.name] / a.start}
    return {
        "seed": seed, "judges": len(judge_agents), "nights": nights,
        "lit_rate": sum(series["lit"]) / nights, "longest": fire.longest,
        "target_p10": tg[len(tg) // 10], "target_med": tg[len(tg) // 2],
        "target_p90": tg[len(tg) * 9 // 10],
        "supply_day1": series["supply"][day - 1] / prm["genesis_supply"],
        "supply_end": series["supply"][-1] / prm["genesis_supply"],
        "hearth_end": series["hearth"][-1], "hearth_min": min(series["hearth"]),
        "judge_nights": judge_nights,
        "pivotal": pivotal / judge_nights if judge_nights else None,
        "judge_mint_share": med(judge_mint_share),
        "judge_npe": med(jn), "judge_end_over_kindling": med(jend),
        "bots": bots, "series": series,
    }


def _task_testnet(args):
    prm, seed, judges, rule = args
    r = run_testnet(prm, seed, judges, rule)
    r.pop("series")
    return r


# ---------------------------------------------------------------------------
# Charts: static SVG, no plotting library
# ---------------------------------------------------------------------------

# Colour-blind-safe categorical slots (validated for adjacent and all-pairs
# use with three series), with separate steps for a dark page. Each SVG
# carries its own background so it stays readable on any page.
SVG_STYLE = """
.c{--bg:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#6f6e69;--grid:#e1e0d9;--axis:#c3c2b7;
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--smoke:#898781}
@media (prefers-color-scheme: dark){.c{--bg:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#a3a29b;
--grid:#2c2c2a;--axis:#4a4a46;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--smoke:#a3a29b}
.b1{fill-opacity:.26}}
.bg{fill:var(--bg)}
text{font-family:system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;fill:var(--ink2);font-size:12px}
.t{fill:var(--ink);font-size:18px;font-weight:600}
.st{fill:var(--ink2);font-size:13px}
.ax{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.axt{fill:var(--ink2);font-size:12px}
.pt{fill:var(--ink);font-size:13px;font-weight:600}
.val{fill:var(--ink2);font-size:11px;font-variant-numeric:tabular-nums}
.grid{stroke:var(--grid);stroke-width:1;fill:none}
.axis{stroke:var(--axis);stroke-width:1;fill:none}
.ref{stroke:var(--muted);stroke-width:1;fill:none}
.l1{stroke:var(--s1);stroke-width:2;fill:none;stroke-linejoin:round;stroke-linecap:round}
.b1{fill:var(--s1);fill-opacity:.14;stroke:none}
.f1{fill:var(--s1)}.f2{fill:var(--s2)}.f3{fill:var(--s3)}
.lit{fill:var(--s2);stroke:var(--bg);stroke-width:2}
.smoke{fill:var(--bg);stroke:var(--smoke);stroke-width:2}
"""


def _esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


class Svg:
    def __init__(self, w, h, title, desc):
        self.w, self.h = w, h
        self.title, self.desc = title, desc
        self.parts = []

    def add(self, s):
        self.parts.append(s)

    def text(self, x, y, s, cls="", anchor="start", extra=""):
        self.add('<text x="%.1f" y="%.1f" class="%s" text-anchor="%s"%s>%s</text>'
                 % (x, y, cls, anchor, extra, _esc(s)))

    def line(self, x1, y1, x2, y2, cls):
        self.add('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" class="%s"/>'
                 % (x1, y1, x2, y2, cls))

    def render(self):
        head = ('<svg xmlns="http://www.w3.org/2000/svg" class="c" width="%d" height="%d" '
                'viewBox="0 0 %d %d" role="img" aria-labelledby="title desc">'
                '<title id="title">%s</title><desc id="desc">%s</desc><style>%s</style>'
                '<rect class="bg" width="%d" height="%d" rx="8"/>'
                % (self.w, self.h, self.w, self.h, _esc(self.title), _esc(self.desc),
                   SVG_STYLE, self.w, self.h))
        return head + "\n".join(self.parts) + "</svg>\n"


def nice_step(span, n=4):
    raw = span / n
    mag = 10 ** math.floor(math.log10(raw))
    for m in (1, 2, 2.5, 5, 10):
        if raw <= m * mag:
            return m * mag
    return 10 * mag


def fmt_ember(v):
    if abs(v) >= 1e6:
        s = "%.2fM" % (v / 1e6)
        return s.replace("0M", "M") if s.endswith("0M") and "." in s else s
    if abs(v) >= 1e3:
        return "%gk" % round(v / 1e3, 1)
    return "%g" % v


def chart_supply(series_by_scenario, path, genesis):
    """Small multiples: supply over the nights for every scenario."""
    names = [s for s in SCENARIO_ORDER if s in series_by_scenario]
    lo = min(min(v["lo"]) for v in series_by_scenario.values())
    hi = max(max(v["hi"]) for v in series_by_scenario.values())
    lo, hi = min(lo, genesis), max(hi, genesis)
    step = nice_step(hi - lo, 4)
    y0 = math.floor(lo / step) * step
    y1 = math.ceil(hi / step) * step
    rows_n = (len(names) + 3) // 4
    svg = Svg(1000, 112 + rows_n * 262 + 22, "Total EMBER supply over 60 nights, by scenario",
              "Small multiples, one per scenario, shared y-axis. Median of the seeds as a "
              "line, lowest to highest seed as a band, genesis supply as a grey line.")
    svg.text(32, 40, "Total EMBER supply over 60 nights, by scenario", "t")
    svg.text(32, 62, "Launch parameters and rules. All panels share the y-axis (total supply, "
             "EMBER); night 0 is genesis, one night is one day.", "st")
    lx = 32
    svg.add('<line x1="%d" y1="86" x2="%d" y2="86" class="l1"/>' % (lx, lx + 22))
    svg.text(lx + 30, 90, "Median of %d seeds" % series_by_scenario[names[0]]["n"])
    lx += 170
    svg.add('<rect x="%d" y="79" width="22" height="14" class="b1"/>' % lx)
    svg.text(lx + 30, 90, "Lowest to highest seed")
    lx += 185
    svg.line(lx, 86, lx + 22, 86, "ref")
    svg.text(lx + 30, 90, "Genesis supply (%s EMBER)" % "{:,}".format(int(genesis)))
    pw, ph = 236, 236
    for i, sc in enumerate(names):
        col, row = i % 4, i // 4
        px, py = 24 + col * pw, 112 + row * (ph + 26)
        x_a, x_b = px + 52, px + pw - 44
        y_a, y_b = py + 30, py + ph - 34
        data = series_by_scenario[sc]
        n = len(data["med"])

        def X(k):
            return x_a + (x_b - x_a) * k / n

        def Y(v):
            return y_b - (y_b - y_a) * (v - y0) / (y1 - y0)

        svg.text(px + 8, py + 14, SCENARIOS[sc]["title"], "pt")
        v = y0
        while v <= y1 + 1e-9:
            svg.line(x_a, Y(v), x_b, Y(v), "grid")
            svg.text(x_a - 6, Y(v) + 4, "%.1fM" % (v / 1e6), "ax", "end")
            v += step
        for k in (0, 20, 40, 60):
            svg.text(X(k), y_b + 16, str(k), "ax", "middle")
        svg.line(x_a, y_b, x_b, y_b, "axis")
        svg.line(x_a, Y(genesis), x_b, Y(genesis), "ref")
        pts_hi = ["%.1f,%.1f" % (X(k + 1), Y(data["hi"][k])) for k in range(n)]
        pts_lo = ["%.1f,%.1f" % (X(k + 1), Y(data["lo"][k])) for k in reversed(range(n))]
        start = "%.1f,%.1f" % (X(0), Y(genesis))
        svg.add('<polygon class="b1" points="%s"/>' % " ".join([start] + pts_hi + pts_lo))
        pts = [start] + ["%.1f,%.1f" % (X(k + 1), Y(data["med"][k])) for k in range(n)]
        svg.add('<polyline class="l1" points="%s"/>' % " ".join(pts))
        end = data["med"][-1]
        svg.add('<circle cx="%.1f" cy="%.1f" r="4" class="f1" stroke="var(--bg)" stroke-width="2"/>'
                % (X(n), Y(end)))
        svg.text(X(n) + 7, Y(end) + 4, "%.2fM" % (end / 1e6), "val")
    svg.text(24 + 2 * pw, 112 + rows_n * (ph + 26) - 4, "Night", "axt", "middle")
    with open(path, "w") as fh:
        fh.write(svg.render())


def chart_target_pile(rows, path, title_extra):
    """Healthy scenario, one seed: target per night as steps, pile as markers."""
    n = len(rows)
    targets = [r["target"] / UNIT for r in rows]
    piles = [r["pile"] / UNIT for r in rows]
    hi = max(max(targets), max(piles))
    step = nice_step(hi, 5)
    y1 = math.ceil(hi / step) * step
    svg = Svg(1000, 470, "Healthy community: target and pile per night",
              "Target as a stepped line, the pile at the end of each night as a marker: "
              "filled for a lit night, hollow for a smoky night.")
    x_a, x_b, y_a, y_b = 88, 960, 112, 410

    def X(k):
        return x_a + (x_b - x_a) * (k + 0.5) / n

    def Y(v):
        return y_b - (y_b - y_a) * v / y1

    svg.text(32, 40, "Healthy community: tonight's target and the pile at the end of the night",
             "t")
    svg.text(32, 62, title_extra, "st")
    lx = 32
    svg.add('<line x1="%d" y1="86" x2="%d" y2="86" class="l1"/>' % (lx, lx + 22))
    svg.text(lx + 30, 90, "Target (EMBER the pile needs)")
    lx += 235
    svg.add('<circle cx="%d" cy="86" r="5" class="lit"/>' % (lx + 8))
    svg.text(lx + 20, 90, "Pile, lit (pile reached the target)")
    lx += 255
    svg.add('<circle cx="%d" cy="86" r="4.5" class="smoke"/>' % (lx + 8))
    svg.text(lx + 20, 90, "Pile, smoke (fell short)")
    v = 0
    while v <= y1 + 1e-9:
        svg.line(x_a, Y(v), x_b, Y(v), "grid")
        svg.text(x_a - 8, Y(v) + 4, fmt_ember(v), "ax", "end")
        v += step
    svg.line(x_a, y_b, x_b, y_b, "axis")
    for night in [1] + list(range(10, n + 1, 10)):
        svg.text(X(night - 1), y_b + 18, str(night), "ax", "middle")
    svg.text((x_a + x_b) / 2, y_b + 40, "Night", "axt", "middle")
    svg.text(24, (y_a + y_b) / 2, "EMBER", "axt", "middle",
             ' transform="rotate(-90 24 %.1f)"' % ((y_a + y_b) / 2))
    d = []
    for k, t in enumerate(targets):
        xl = x_a + (x_b - x_a) * k / n
        xr = x_a + (x_b - x_a) * (k + 1) / n
        d.append(("M" if k == 0 else "L") + "%.1f,%.1f L%.1f,%.1f" % (xl, Y(t), xr, Y(t)))
    svg.add('<path class="l1" d="%s"/>' % " ".join(d))
    for k, r in enumerate(rows):
        cls = "lit" if r["lit"] else "smoke"
        svg.add('<circle cx="%.1f" cy="%.1f" r="%s" class="%s"><title>night %d: pile %s, '
                'target %s, %s</title></circle>'
                % (X(k), Y(piles[k]), "5" if r["lit"] else "4.5", cls, k + 1,
                   "{:,.0f}".format(piles[k]), "{:,.0f}".format(targets[k]),
                   "lit" if r["lit"] else "smoke"))
    with open(path, "w") as fh:
        fh.write(svg.render())


def chart_rewards(panels, series, path, subtitle):
    """Grouped horizontal bars: net reward per EMBER thrown.

    panels: [(panel title, [(row label, {series key: value or None})])]
    series: [(series key, label, css class)]
    """
    vals = [v for _, rows in panels for _, d in rows for v in d.values() if v is not None]
    lo, hi = min(0.0, min(vals)), max(0.0, max(vals))
    step = nice_step(hi - lo, 5)
    v0 = math.floor(lo / step) * step
    v1 = math.ceil(hi / step) * step
    bar, gap, group_gap = 12, 2, 22
    nrows = max(len(rows) for _, rows in panels)
    group_h = len(series) * (bar + gap) - gap
    plot_h = nrows * (group_h + group_gap)
    W = 1100
    H = 150 + plot_h + 44
    svg = Svg(W, H, "Net reward per EMBER thrown, by behaviour and by when the wood landed",
              "Grouped horizontal bars, one colour per scenario, zero line in the middle.")
    svg.text(32, 40, "Net reward per EMBER thrown: by behaviour and by when the wood landed", "t")
    svg.text(32, 62, subtitle, "st")
    lx = 32
    for key, label, cls in series:
        svg.add('<rect x="%d" y="80" width="14" height="14" rx="3" class="%s"/>' % (lx, cls))
        svg.text(lx + 22, 91, label)
        lx += 40 + 7.2 * len(label)
    panel_w = (W - 64) / len(panels)
    for pi, (ptitle, rows) in enumerate(panels):
        px = 32 + pi * panel_w
        label_w = 200
        x_a, x_b = px + label_w, px + panel_w - 56
        y_a = 140

        def X(v):
            return x_a + (x_b - x_a) * (v - v0) / (v1 - v0)

        svg.text(px, 124, ptitle, "pt")
        v = v0
        while v <= v1 + 1e-9:
            svg.line(X(v), y_a - 6, X(v), y_a + plot_h - group_gap + 6, "grid")
            svg.text(X(v), y_a + plot_h - group_gap + 22, "%+g %%" % round(v * 100, 2)
                     if v else "0", "ax", "middle")
            v += step
        svg.line(X(0), y_a - 6, X(0), y_a + plot_h - group_gap + 6, "axis")
        for ri, (label, d) in enumerate(rows):
            gy = y_a + ri * (group_h + group_gap)
            for li, part in enumerate(label.split("\n")):
                svg.text(px, gy + 12 + li * 15, part, "axt" if li == 0 else "ax")
            for si, (key, slabel, cls) in enumerate(series):
                val = d.get(key)
                by = gy + si * (bar + gap)
                if val is None:
                    svg.text(X(0) + 6, by + bar - 2, "no wood thrown", "ax")
                    continue
                xa, xb = sorted((X(0), X(val)))
                w = max(xb - xa, 1.0)
                r = min(4.0, w / 2)
                if val >= 0:
                    p = ("M%.1f,%.1f h%.1f a%.1f,%.1f 0 0 1 %.1f,%.1f v%.1f a%.1f,%.1f 0 0 1 "
                         "%.1f,%.1f h%.1f z" % (xa, by, w - r, r, r, r, r, bar - 2 * r, r, r,
                                                -r, r, -(w - r)))
                else:
                    p = ("M%.1f,%.1f L%.1f,%.1f A%.1f,%.1f 0 0 0 %.1f,%.1f L%.1f,%.1f "
                         "A%.1f,%.1f 0 0 0 %.1f,%.1f L%.1f,%.1f Z"
                         % (xb, by, xa + r, by, r, r, xa, by + r, xa, by + bar - r,
                            r, r, xa + r, by + bar, xb, by + bar))
                svg.add('<path class="%s" d="%s"><title>%s, %s: %+.2f %%</title></path>'
                        % (cls, p, slabel, label.split("\n")[0], val * 100))
                tx = X(val) + (5 if val >= 0 else -5)
                svg.text(tx, by + bar - 2, "%+.2f %%" % (val * 100), "val",
                         "start" if val >= 0 else "end")
    svg.text(W / 2, H - 14, "Net reward per EMBER thrown, % (mint received minus wood burned, "
             "divided by wood thrown; median of seeds)", "axt", "middle")
    with open(path, "w") as fh:
        fh.write(svg.render())


# ---------------------------------------------------------------------------
# Report: markdown tables, generated blocks in docs/SIMULATION.md
# ---------------------------------------------------------------------------

def pct(v, digits=1, sign=False):
    if v is None:
        return "n/a"
    if v == float("inf"):
        return "inf"
    return ("%+.*f %%" if sign else "%.*f %%") % (digits, v * 100)


def table(head, rows):
    out = ["| " + " | ".join(head) + " |", "|" + "|".join("---" for _ in head) + "|"]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def md_scenarios(agg, seeds):
    rows = []
    for sc in SCENARIO_ORDER:
        a = agg.get(sc)
        if not a:
            continue
        rows.append([
            SCENARIOS[sc]["title"],
            "%.3f (%.3f-%.3f)" % (a["supply_ratio"], a["supply_ratio_lo"], a["supply_ratio_hi"]),
            "%.0f %%" % (a["lit_rate"] * 100),
            "%d" % a["longest"],
            "{:,.0f}".format(a["tallest"]),
            "{:,.0f}".format(a["hearth_end"]),
            pct(a["npe_loyal"], 2, True),
            pct(a["npe_fair_weather"], 2, True),
            pct(a["npe_sniper_complete"], 2, True),
            pct(a["npe_sniper_pile"], 2, True),
            pct(a["free_delta"], 1, True),
        ])
    return table(["Scenario", "Supply night 60 (x genesis, seed range)", "Lit nights",
                  "Longest streak", "Tallest fire (EMBER)", "Hearth night 60 (EMBER)",
                  "Early (loyal)", "Late (fair-weather)", "Sniping: completing",
                  "Sniping: piling on", "Free riders' share"],
                 rows) + ("\n\nMedians over %d seeds. Early, late and the two sniping columns: "
                          "net reward per EMBER thrown (mint received minus wood burned, "
                          "divided by wood thrown, over all 60 nights). Sniping is split into "
                          "the throws that make the fire safe and the wood piled onto a fire "
                          "that is already safe. The last column: the change in the founding "
                          "free riders' share of total supply from genesis to night 60." % seeds)


def md_criteria(results):
    """results: [(label, criteria list)] side by side."""
    names = [c[0] for c in results[0][1]]
    rows = []
    for i, name in enumerate(names):
        row = [name]
        for _, crit in results:
            _, ok, detail = crit[i]
            row.append(("pass" if ok else "**FAIL**") + ", " + detail)
        rows.append(row)
    return table(["Criterion"] + [label for label, _ in results], rows)


def md_buckets(aggs):
    labels = [("early", "early (first third of the night)"),
              ("middle", "middle third"),
              ("late", "last third, before the fire is safe"),
              ("crossing", "the throw that crosses the target, all of it"),
              ("gap", "only the part of that throw that closes the gap"),
              ("after_lit", "after the fire is already safe")]
    rows = []
    for key, label in labels:
        rows.append([label] + [pct(a.get("b_" + key), 2, True) for _, a in aggs])
    return table(["Wood that landed ..."] + [t for t, _ in aggs], rows)


def md_rules(aggs):
    """The launch values under each rule set, side by side."""
    order = ["design", "clock", MAIN_RULE] + [r for r in aggs if r not in ("design", "clock", MAIN_RULE)]
    rows = []
    spec = [("healthy", "npe_loyal", "healthy: early (loyal), per EMBER", "pct"),
            ("healthy", "npe_sniper_complete", "healthy: sniping, completing throws, per EMBER", "pct"),
            ("sniper", "npe_loyal", "sniper-heavy: early (loyal), per EMBER", "pct"),
            ("sniper", "npe_sniper_complete", "sniper-heavy: sniping, completing throws, per EMBER", "pct"),
            ("whale", "npe_whale_sniper_complete", "whale-dominated: whale's end-of-night throws, per EMBER", "pct"),
            ("whale", "npe_loyal", "whale-dominated: early (loyal), per EMBER", "pct"),
            ("solo", "npe_solo_lighter", "solo lighter: its reward per EMBER", "pct"),
            ("solo", "solo_share", "solo lighter: its share of the throwers' mint", "share"),
            ("solo", "npe_loyal", "solo lighter's community: early (loyal), per EMBER", "pct"),
            ("solo", "supply_ratio", "solo lighter's community: supply night 60 (x genesis)", "ratio"),
            ("healthy", "lit_rate", "healthy: lit nights", "share"),
            ("healthy", "supply_ratio", "healthy: supply night 60 (x genesis)", "ratio")]
    for sc, key, label, kind in spec:
        row = [label]
        for r in order:
            v = aggs[r].get(sc, {}).get(key)
            if v is None:
                row.append("n/a")
            elif kind == "pct":
                row.append(pct(v, 2, True))
            elif kind == "share":
                row.append("%.0f %%" % (v * 100))
            else:
                row.append("%.3f" % v)
        rows.append(row)
    head = ["Launch values"] + [RULE_NAMES[r] + (" (%d windows)" % POOL_WINDOWS if r == "pooled" else "")
                               for r in order]
    return table(head, rows)


def md_splitter(tests):
    rows = []
    for t in tests:
        rows.append([t["label"], t["rule"], "{:,}".format(t["one"]), "{:,}".format(t["many"]),
                     "{:,}".format(t["many"] - t["one"]), "%.2e" % (abs(t["many"] - t["one"]) / t["one"])])
    return table(["Splitter behaviour", "Rule", "Balance night 60, 1 account (yoctoEMBER)",
                  "Same balance split over 64 accounts", "Difference (yocto)",
                  "Difference / balance"], rows)


def md_farm(agg_h, agg_f, prm):
    h, f = agg_h, agg_f
    per_night = prm["kindling"] * prm["kindling_per_night"]
    rows = [
        ["Kindling paid out over 60 nights (EMBER)", "{:,.0f}".format(h["kindling_paid"]),
         "{:,.0f}".format(f["kindling_paid"])],
        ["... of which taken by the farm", "0", "{:,.0f}".format(f["farm_haul"])],
        ["Newcomers who got kindling", "%.0f of %.0f" % (h["newcomers_kindled"], h["newcomers_seen"]),
         "%.0f of %.0f" % (f["newcomers_kindled"], f["newcomers_seen"])],
        ["Hearth at night 60 (EMBER)", "{:,.0f}".format(h["hearth_end"]),
         "{:,.0f}".format(f["hearth_end"])],
        ["Supply at night 60 (x genesis)", "%.3f" % h["supply_ratio"], "%.3f" % f["supply_ratio"]],
    ]
    return table(["Healthy community", "without farm", "with a farm that wins every slot"],
                 rows) + ("\n\nThe farm's ceiling is kindling x kindling_per_night = %s EMBER "
                          "per night, %s EMBER over 60 nights (%.0f %% of hearth_genesis)."
                          % ("{:,}".format(per_night), "{:,}".format(per_night * 60),
                             per_night * 60 / prm["hearth_genesis"] * 100))


def _find(rows, **want):
    for r in rows:
        if all(r["combo"][k] == v for k, v in want.items()):
            return r
    return None


def md_sweep(report, pick):
    out = []
    for st in report:
        out.append("**Stage %s.** Knobs: %s. Scenarios: %s. %d combinations x %d seeds; "
                   "%d pass the stage's acceptance criteria, %d also pass the stricter "
                   "selection margins. Pick: %s."
                   % (st["title"], ", ".join("`%s`" % k for k in st["keys"]),
                      ", ".join(st["scenarios"]), st["n"], len(SWEEP_SEEDS), st["n_pass"],
                      st["n_sel"], ", ".join("`%s` = %s" % (k, v) for k, v in st["pick"].items())))
        out.append("")
    A, B, C = report
    rows = []
    for g in SWEEP_GRID["grow_pct"]:
        row = ["%g %%" % (g / 100)]
        for sh in SWEEP_GRID["shrink_pct"]:
            r = _find(A["rows"], grow_pct=g, shrink_pct=sh, target_start=A["pick"]["target_start"],
                      target_cap=A["pick"]["target_cap"])
            row.append("%.0f %% (%.0f %%)" % (r["agg"]["healthy"]["lit_rate"] * 100,
                                              p_star(g, sh) * 100))
        rows.append(row)
    out.append("Healthy lit rate over 60 nights by `grow_pct` (rows) and `shrink_pct` "
               "(columns), at `target_start` = %s; in brackets the long-run lit rate "
               "ln(1/(1-shrink)) / (ln(1+grow) + ln(1/(1-shrink))) that the target settles "
               "to once it has found the community's capacity:"
               % "{:,}".format(A["pick"]["target_start"]))
    out.append("")
    out.append(table(["grow \\ shrink"] + ["%g %%" % (v / 100) for v in SWEEP_GRID["shrink_pct"]],
                     rows))
    out.append("")
    rows = []
    for ts in SWEEP_GRID["target_start"]:
        r = _find(A["rows"], grow_pct=A["pick"]["grow_pct"], shrink_pct=A["pick"]["shrink_pct"],
                  target_start=ts, target_cap=A["pick"]["target_cap"])
        h = r["agg"]["healthy"]
        rows.append(["{:,} ({:.1f} % of supply)".format(ts, ts / pick["genesis_supply"] * 100),
                     "%.0f %%" % (h["lit_rate"] * 100), "%d" % h["longest"],
                     "%d" % h["smoke_nights"]])
    out.append("Healthy community by `target_start`, at the picked `grow_pct` and `shrink_pct`:")
    out.append("")
    out.append(table(["target_start", "lit nights", "longest streak", "smoke nights"], rows))
    out.append("")
    rows = []
    for tc in SWEEP_GRID["target_cap"]:
        r = _find(A["rows"], grow_pct=A["pick"]["grow_pct"], shrink_pct=A["pick"]["shrink_pct"],
                  target_start=A["pick"]["target_start"], target_cap=tc)
        h, so = r["agg"]["healthy"], r["agg"]["solo"]
        rows.append(["%g %% of free supply" % (tc / 100), "%.0f %%" % (h["lit_rate"] * 100),
                     "%.3f" % h["supply_ratio"], "%.0f" % h["capped_nights"],
                     "%.3f" % so["supply_ratio"], "%.0f" % so["capped_nights"]])
    out.append("By `target_cap`, at the other stage-A picks (nights capped: nights on which the "
               "cap lowered the next target):")
    out.append("")
    out.append(table(["target_cap", "healthy: lit", "healthy: supply night 60",
                      "healthy: nights capped", "solo lighter: supply night 60",
                      "solo lighter: nights capped"], rows))
    out.append("")
    rows = []
    for em in SWEEP_GRID["early_max"]:
        row = ["%g" % (em / BPS)]
        for sm in SWEEP_GRID["smoke_pct"]:
            r = _find(B["rows"], early_max=em, smoke_pct=sm, mint_pct=B["pick"]["mint_pct"],
                      late_lit=B["pick"]["late_lit"])
            row.append("%s / %s" % (fmt_edge(edge(r["agg"]["healthy"])),
                                    fmt_edge(edge(r["agg"]["sniper"]))))
        rows.append(row)
    out.append("Early wood's net reward per EMBER over the best sniping wood's (healthy / "
               "sniper-heavy), by `early_max` (rows) and `smoke_pct` (columns), at "
               "`mint_pct` = %s and `late_lit` = %s:" % (B["pick"]["mint_pct"], B["pick"]["late_lit"]))
    out.append("")
    out.append(table(["early_max \\ smoke"] + ["%g %%" % (v / 100) for v in SWEEP_GRID["smoke_pct"]],
                     rows))
    out.append("")
    rows = []
    for ll in SWEEP_GRID["late_lit"]:
        r = _find(B["rows"], late_lit=ll, early_max=B["pick"]["early_max"],
                  smoke_pct=B["pick"]["smoke_pct"], mint_pct=B["pick"]["mint_pct"])
        hs, sn, so = r["agg"]["healthy"], r["agg"]["sniper"], r["agg"]["solo"]
        rows.append(["%g" % (ll / BPS), pct(sn["npe_loyal"], 2, True),
                     pct(sn["npe_sniper_complete"], 2, True), pct(sn["npe_sniper_pile"], 2, True),
                     "%.1f %%" % (sn["riskless_share"] * 100), fmt_edge(edge(hs)),
                     fmt_edge(edge(sn)), "%.0f %%" % (so["solo_share"] * 100),
                     pct(so["npe_loyal"], 2, True)])
    out.append("Sniper-heavy community by `late_lit`, other stage-B knobs at their pick. "
               "\"Riskless share\" is the part of the throwers' mint that went to wood thrown "
               "onto a fire that was already safe:")
    out.append("")
    out.append(table(["late_lit", "early (loyal)", "sniping: completing", "sniping: piling on",
                      "riskless share", "edge, healthy", "edge, sniper-heavy",
                      "solo lighter's share of the mint", "early wood beside a solo lighter"],
                     rows))
    out.append("")
    rows = []
    for k in SWEEP_GRID["kindling"]:
        row = ["{:,}".format(k)]
        for cap in SWEEP_GRID["kindling_per_night"]:
            r = _find(C["rows"], kindling=k, kindling_per_night=cap,
                      hearth_cut=C["pick"]["hearth_cut"], hearth_burn_pct=C["pick"]["hearth_burn_pct"])
            ag = r["agg"]
            keep = ag["farm"]["hearth_end"] / ag["healthy"]["hearth_end"]
            row.append("%.0f %% / %.0f %%" % (keep * 100, ag["healthy"]["kindled_rate"] * 100))
        rows.append(row)
    out.append("Hearth kept under a farm that wins every slot (relative to no farm) / newcomers "
               "served without a farm, by `kindling` (rows) and `kindling_per_night` (columns):")
    out.append("")
    out.append(table(["kindling \\ per night"] + [str(c) for c in SWEEP_GRID["kindling_per_night"]],
                     rows))
    out.append("")
    rows = []
    for hb in SWEEP_GRID["hearth_burn_pct"]:
        row = ["%g %%" % (hb / 100)]
        for hc in SWEEP_GRID["hearth_cut"]:
            r = _find(C["rows"], hearth_burn_pct=hb, hearth_cut=hc, kindling=C["pick"]["kindling"],
                      kindling_per_night=C["pick"]["kindling_per_night"])
            fr = r["agg"]["free_rider"]
            row.append("%.3f / %+.1f %%" % (fr["supply_ratio"], fr["free_delta"] * 100))
        rows.append(row)
    out.append("Free-rider-heavy community: supply at night 60 (x genesis) / change in the free "
               "riders' share, by `hearth_burn_pct` (rows) and `hearth_cut` (columns):")
    out.append("")
    out.append(table(["hearth_burn \\ hearth_cut"] + ["%g %%" % (v / 100) for v in SWEEP_GRID["hearth_cut"]],
                     rows))
    return "\n".join(out)


def p_star(grow, shrink):
    up = math.log(1 + grow / BPS)
    down = -math.log(1 - shrink / BPS)
    return down / (up + down)


def md_sensitivity(sens):
    names = [c[0] for c in sens[0]["crit"]]
    rows = []
    for s in sens:
        a = s["agg"]
        fails = [c[0] for c in s["crit"] if not c[1]]
        label = "launch values" if s["key"] == "launch" else "`%s` = %s" % (s["key"], s["value"])
        rows.append([label,
                     "%.0f %%" % (a["healthy"]["lit_rate"] * 100),
                     "%.3f" % a["healthy"]["supply_ratio"],
                     "%.3f-%.3f" % (min(x["supply_min_worst"] for x in a.values()),
                                    max(x["supply_max_worst"] for x in a.values())),
                     fmt_edge(edge(a["healthy"])), fmt_edge(edge(a["sniper"])),
                     "%.0f %%" % (a["farm"]["hearth_end"] / a["healthy"]["hearth_end"] * 100),
                     "; ".join(fails) if fails else "none"])
    return table(["Variant", "Healthy lit", "Healthy supply", "Supply band, all scenarios",
                  "Edge, healthy", "Edge, sniper-heavy", "Farm keeps", "Criteria failed"], rows)


def md_testnet(tn, prm_t):
    rows = []
    for label, r in tn:
        rows.append([label, "%.0f %%" % (r["lit_rate"] * 100), "%d" % r["longest"],
                     "{:,.0f} / {:,.0f} / {:,.0f}".format(r["target_p10"], r["target_med"],
                                                         r["target_p90"]),
                     "%.3f / %.3f" % (r["supply_day1"], r["supply_end"]),
                     "{:,.0f}".format(r["hearth_end"]),
                     "n/a" if r["pivotal"] is None else "%.0f %%" % (r["pivotal"] * 100),
                     "n/a" if r["judge_mint_share"] is None else "%.0f %%" % (r["judge_mint_share"] * 100),
                     "n/a" if r["judge_npe"] is None else pct(r["judge_npe"], 2, True)])
    return table(["Testnet run (%d days, medians over seeds)" % TESTNET_DAYS, "Lit nights",
                  "Longest streak", "Target p10 / median / p90", "Supply day 1 / day %d (x genesis)"
                  % TESTNET_DAYS, "Hearth at the end", "Judge nights decided by the judge",
                  "Judges' share of the mint on lit nights", "Judges' net reward per EMBER"],
                 rows) + md_drain(prm_t)


def md_drain(prm):
    per_hour = 3_600_000 // prm["night_ms"]
    rate = prm["kindling"] * prm["kindling_per_night"] * per_hour
    hours = prm["hearth_genesis"] / rate
    return ("\n\nKindling drain: at most %s EMBER a night x %d nights an hour = %s EMBER an hour. "
            "A script that wins every claim empties the %s EMBER hearth in no less than %.0f hours "
            "(%.1f days), refills from lit nights not counted."
            % ("{:,}".format(prm["kindling"] * prm["kindling_per_night"]), per_hour,
               "{:,}".format(rate), "{:,}".format(prm["hearth_genesis"]), hours, hours / 24))


def inject(doc_path, blocks):
    """Replace <!-- BEGIN generated:NAME --> ... <!-- END generated:NAME --> blocks."""
    if not os.path.exists(doc_path):
        return False
    text = open(doc_path).read()
    for name, body in blocks.items():
        a = "<!-- BEGIN generated:%s -->" % name
        b = "<!-- END generated:%s -->" % name
        i, j = text.find(a), text.find(b)
        if i < 0 or j < 0:
            continue
        text = text[:i + len(a)] + "\n" + body.strip() + "\n" + text[j:]
    with open(doc_path, "w") as fh:
        fh.write(text)
    return True


# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------

# sim/params.json uses the contract's Config field names and units (contract/src/config.rs):
# amounts in base units as decimal strings, rates and factors in basis points.
CONTRACT_FIELDS = [
    # (contract field, simulation key, kind)
    ("night_ms", "night_ms", "int"),
    ("hearth_genesis", "hearth_genesis", "amount"),
    ("target_start", "target_start", "amount"),
    ("target_min", "target_min", "amount"),
    ("grow_bp", "grow_pct", "int"),
    ("shrink_bp", "shrink_pct", "int"),
    ("mint_bp", "mint_pct", "int"),
    ("hearth_cut_bp", "hearth_cut", "int"),
    ("smoke_bp", "smoke_pct", "int"),
    ("hearth_burn_bp", "hearth_burn_pct", "int"),
    ("early_max_bp", "early_max", "int"),
    ("late_lit_bp", "late_lit", "int"),
    ("pool_windows", "pool_windows", "int"),
    ("target_cap_bp", "target_cap", "int"),
    ("min_throw", "min_throw", "amount"),
    ("kindling", "kindling", "amount"),
    ("kindling_per_night", "kindling_per_night", "int"),
    ("max_catchup", "max_catchup", "int"),
    ("log_keep", "log_keep", "int"),
]
DECIMALS = 18
# The testnet variant keeps the launch economics and changes only these.
TESTNET_OVERRIDES = {"night_ms": 300_000, "genesis_supply": 1_000_000, "hearth_genesis": 900_000,
                     "target_start": 400, "target_min": 100, "min_throw": 1, "kindling": 200,
                     "kindling_per_night": 1, "max_catchup": 30, "log_keep": 48}
TESTNET_BOT_TEXT = {
    "demo-bot-early-a": "early: on 90 % of nights, in the first fifth of the night, throws about "
                        "200 EMBER (plus or minus 25 %)",
    "demo-bot-early-b": "early: on 90 % of nights, in the first fifth of the night, throws about "
                        "150 EMBER (plus or minus 25 %)",
    "demo-bot-steady": "fair-weather: on 85 % of nights, between 40 % and 80 % of the night, throws "
                       "about 150 EMBER if the streak is at least 2 or the pile is at 60 % of the target",
    "demo-bot-late": "sniper: on 90 % of nights, in the last tenth: if the pile is at 80 % of the "
                     "target and 100 EMBER close the gap, throws exactly the gap (or 100 EMBER "
                     "when late_lit > 0); otherwise does nothing",
    "demo-bot-idle": "free rider: never throws",
}


def base_units(ember):
    return str(ember * 10 ** DECIMALS)


def params_document(sim, tn):
    """The contents of sim/params.json for a launch pick `sim` and its testnet variant `tn`."""
    def config(prm, max_accounts, history_keep):
        cfg = {"name": "Bonfire", "symbol": "EMBER", "decimals": DECIMALS}
        for field, key, kind in CONTRACT_FIELDS:
            cfg[field] = base_units(prm[key]) if kind == "amount" else prm[key]
        cfg["max_accounts"] = max_accounts
        cfg["history_keep"] = history_keep
        return cfg
    return {
        "about": "Launch parameters picked by sim/bonfire_sim.py; reasons and evidence in "
                 "docs/SIMULATION.md. Field names and units are those of the contract's Config "
                 "(contract/src/config.rs).",
        "units": "Amounts are base units (10^decimals per EMBER) as decimal strings. Fields "
                 "ending in _bp are basis points: 10,000 bp = 100 % = a factor of 1.0. "
                 "night_ms is milliseconds.",
        "notes": [
            "target_cap_bp is new: target_next = min(rule result, (supply - hearth - pile) * "
            "target_cap_bp / 10,000), never below target_min.",
            "max_throwers_per_night is gone: the contract pays throwers lazily (pull payments).",
            "early_max_bp is the weight factor of wood on an empty pile; it falls linearly to "
            "1.0 at the target (weighting by pile position).",
            "pool_windows is new: the night is cut into this many equal windows, and all wood "
            "that lands in one window shares, pro rata, the slice of the pile that window's "
            "wood covers (see docs/SIMULATION.md).",
        ],
        "simulation": {
            "config": config(sim, 64 + sim["hearth_genesis"] // sim["kindling"], 1024),
            "founders_total": base_units(sim["genesis_supply"] - sim["hearth_genesis"]),
            "founders_note": "The simulation spreads founders_total over its simulated community. "
                             "The real init call lists at most 64 founders.",
        },
        "testnet": {
            "config": config(tn, len(TESTNET_BOTS) + tn["hearth_genesis"] // tn["kindling"], 4096),
            "founders": [{"account_id": "REPLACE-WITH-ACCOUNT-ID:" + name,
                          "amount": base_units(bal)} for name, _, bal, _ in TESTNET_BOTS],
            "demo_bots": [{"label": name, "behaviour": TESTNET_BOT_TEXT[name],
                           "throw": base_units(size)} for name, _, _, size in TESTNET_BOTS],
        },
    }


def testnet_params(sim):
    return dict(sim, **TESTNET_OVERRIDES)


def from_config(cfg, founders_total):
    prm = {}
    unit = 10 ** cfg["decimals"]
    for field, key, kind in CONTRACT_FIELDS:
        v = cfg[field]
        if kind == "amount":
            v = int(v)
            if v % unit:
                raise SystemExit("%s: not a whole number of EMBER" % field)
            v //= unit
        prm[key] = v
    prm["genesis_supply"] = prm["hearth_genesis"] + int(founders_total) // unit
    return prm


def load_params():
    with open(PARAMS_FILE) as fh:
        data = json.load(fh)
    sim = dict(DESIGN_GUESS, **from_config(data["simulation"]["config"],
                                           data["simulation"]["founders_total"]))
    tn_cfg = data["testnet"]["config"]
    founders = data["testnet"]["founders"]
    tn = dict(DESIGN_GUESS, **from_config(tn_cfg, sum(int(f["amount"]) for f in founders)))
    bots = [(f["account_id"].split(":")[-1], int(f["amount"]) // 10 ** tn_cfg["decimals"])
            for f in founders]
    if bots != [(n, bal) for n, _, bal, _ in TESTNET_BOTS]:
        raise SystemExit("testnet founders in sim/params.json differ from TESTNET_BOTS")
    if tn != testnet_params(sim):
        raise SystemExit("the testnet block differs from the launch values plus TESTNET_OVERRIDES")
    return sim, tn


def write_params(sim):
    with open(PARAMS_FILE, "w") as fh:
        json.dump(params_document(sim, testnet_params(sim)), fh, indent=2)
        fh.write("\n")


def series_bands(runs):
    meds, los, his = [], [], []
    n = len(runs[0]["series"]["supply"])
    for k in range(n):
        vals = [r["series"]["supply"][k] for r in runs]
        meds.append(statistics.median(vals))
        los.append(min(vals))
        his.append(max(vals))
    return {"med": meds, "lo": los, "hi": his, "n": len(runs)}


def splitter_tests(prm, workers):
    """The same balance as one account and as 64 accounts, everything else equal.
    min_throw is set to zero here: it refuses pieces below it, which only ever hurts
    a splitter, and would hide what the weighting rule does."""
    prm = dict(prm, min_throw=0)
    tasks, labels = [], []
    for sc, label in (("splitter", "loyal (throws early)"),
                      ("splitter_sniper", "sniper (completes the fire)")):
        for rule in ("design", MAIN_RULE):
            for seed in SEEDS:
                for k in (1, 64):
                    tasks.append((prm, sc, seed, rule, k))
            labels.append((sc, label, rule))
    res = run_many(tasks, workers, _task_split)
    tests = []
    i = 0
    for sc, label, rule in labels:
        ones = manys = 0
        for seed in SEEDS:
            ones += res[i]
            manys += res[i + 1]
            i += 2
        tests.append({"label": label, "rule": RULE_NAMES[rule],
                      "one": ones // len(SEEDS), "many": manys // len(SEEDS)})
    return tests


def _task_split(args):
    prm, sc, seed, rule, k = args
    return run(prm, sc, seed, rule, split_accounts=k)["splitter"]["end"]


def main(argv=None):
    ap = argparse.ArgumentParser(description="Bonfire community simulation")
    ap.add_argument("command", nargs="?", default="all",
                    choices=["all", "scenarios", "sweep", "testnet"])
    ap.add_argument("--workers", type=int, default=max(1, min(4, os.cpu_count() or 1)))
    ap.add_argument("--write-params", action="store_true",
                    help="write the sweep's pick to sim/params.json (all always does)")
    ap.add_argument("--start", choices=["guess", "params"], default="guess",
                    help="start the sweep from the first guess or from sim/params.json")
    ap.add_argument("--rounds", type=int, default=SWEEP_ROUNDS,
                    help="most rounds of the sweep")
    args = ap.parse_args(argv)
    prm, prm_t = load_params()
    os.makedirs(DOCS_SIM, exist_ok=True)
    blocks = {}

    if args.command in ("all", "sweep"):
        start = DESIGN_GUESS if args.start == "guess" else dict(DESIGN_GUESS, **prm)
        pick, report, history = sweep(start, args.workers, rounds=args.rounds)
        if args.write_params or args.command == "all":
            write_params(pick)
            prm, prm_t = load_params()
            print("wrote sim/params.json")
        same = all(pick[k] == prm[k] for k in SWEEP_GRID)
        note = ("The sweep's pick matches `sim/params.json`." if same else
                "The sweep's pick differs from `sim/params.json` in: %s."
                % ", ".join("`%s` (sweep %s, params.json %s)" % (k, pick[k], prm[k])
                            for k in SWEEP_GRID if pick[k] != prm[k]))
        print(note)
        sens = sensitivity(prm, args.workers)
        rounds = "\n".join("- after round %d: %s" % (i + 1, ", ".join(
            "`%s` = %s" % (k, v) for k, v in h.items())) for i, h in enumerate(history))
        origin = ("the first guess" if args.start == "guess"
                  else "the values in `sim/params.json`")
        blocks["sweep"] = (md_sweep(report, pick) + "\n\nThis run started from %s. Picks per "
                           "round (the tables above show the last round):\n\n" % origin
                           + rounds + "\n\n" + note)
        blocks["sensitivity"] = md_sensitivity(sens)

    if args.command in ("all", "scenarios"):
        compare = [r for r in RULESETS if r != MAIN_RULE]
        print("scenarios: %d scenarios x %d seeds, rules %s and for comparison %s"
              % (len(SCENARIO_ORDER), len(SEEDS), MAIN_RULE, ", ".join(compare)))
        runs = run_many([(prm, sc, seed, MAIN_RULE) for sc in SCENARIO_ORDER for seed in SEEDS],
                        args.workers, _task_full)
        agg = aggregate([summarize(r) for r in runs])
        aggs = {MAIN_RULE: agg}
        for rule in compare:
            aggs[rule] = aggregate(run_many([(prm, sc, seed, rule) for sc in SCENARIO_ORDER
                                             for seed in SEEDS], args.workers))
        agg_guess = aggregate(run_many([(DESIGN_GUESS, sc, seed, "design")
                                        for sc in SCENARIO_ORDER for seed in SEEDS],
                                       args.workers))
        crit = criteria(agg)
        for name, ok, detail in crit:
            print("  %s  %s (%s)" % ("PASS" if ok else "FAIL", name, detail))
        tests = splitter_tests(prm, args.workers)
        blocks["scenarios"] = md_scenarios(agg, len(SEEDS))
        blocks["criteria"] = md_criteria([
            ("first guess, DESIGN.md rules", criteria(agg_guess)),
            ("launch values, DESIGN.md rules", criteria(aggs["design"])),
            ("launch values, pile position without pooling", criteria(aggs["position"])),
            ("launch values, kindlers and warmers", criteria(aggs["warm"])),
            ("launch values, pooled windows (launch rule)", crit)])
        wins = [2, 4, 8, 24]
        wsc = ["healthy", "sniper", "solo"]
        wres = run_many([(dict(prm, pool_windows=w), sc, seed, "pooled") for w in wins
                         for sc in wsc for seed in SEEDS], args.workers)
        per = len(wsc) * len(SEEDS)
        wrows = []
        for i, w in enumerate(wins):
            a = aggregate(wres[i * per:(i + 1) * per])
            wrows.append([str(w), "%.0f minutes" % (prm["night_ms"] / w / 60000),
                          fmt_edge(edge(a["healthy"])), fmt_edge(edge(a["sniper"])),
                          "%.0f %%" % (a["solo"]["solo_share"] * 100),
                          pct(a["solo"]["npe_loyal"], 2, True)])
        blocks["windows"] = table(["pool_windows", "window length", "early edge, healthy",
                                   "early edge, sniper-heavy", "solo lighter's share of the mint",
                                   "early wood beside a solo lighter"], wrows)
        blocks["buckets"] = md_buckets([(SCENARIOS[x]["title"], agg[x])
                                        for x in ("healthy", "sniper", "whale", "fading")])
        blocks["rules"] = md_rules(aggs)
        blocks["splitter"] = md_splitter(tests)
        blocks["farm"] = md_farm(agg["healthy"], agg["farm"], prm)
        blocks["guess"] = md_scenarios(agg_guess, len(SEEDS))
        # charts
        bands = {}
        for sc in SCENARIO_ORDER:
            bands[sc] = series_bands([r for r in runs if r["scenario"] == sc])
        chart_supply(bands, os.path.join(DOCS_SIM, "supply.svg"), prm["genesis_supply"])
        h1 = [r for r in runs if r["scenario"] == "healthy" and r["seed"] == 1][0]
        lit_n = sum(1 for r in h1["rows"] if r["lit"])
        chart_target_pile(h1["rows"], os.path.join(DOCS_SIM, "target_pile.svg"),
                          "Seed 1, launch parameters: lit %d of %d nights, longest streak %d nights, "
                          "tallest fire %s EMBER." % (lit_n, len(h1["rows"]), h1["longest"],
                                                      "{:,.0f}".format(h1["tallest"])))
        show = [("healthy", "Healthy", "f1"), ("sniper", "Sniper-heavy", "f2"),
                ("fading", "Fading", "f3")]
        behaviours = [("Loyal\nthrows early", "npe_loyal"),
                      ("Fair-weather\nmid-night, if streak or pile", "npe_fair_weather"),
                      ("Sniper, completing\nlast tenth, throw makes it safe", "npe_sniper_complete"),
                      ("Sniper, piling on\nlast tenth, fire already safe", "npe_sniper_pile"),
                      ("Whale\nearly to mid-night", "npe_whale")]
        timing = [("Early\nfirst third of the night", "b_early"),
                  ("Middle\nmiddle third", "b_middle"),
                  ("Late\nlast third, fire not yet safe", "b_late"),
                  ("Completing\nthe part that closes the gap", "b_gap"),
                  ("Piled on\nthe fire was already safe", "b_after_lit")]
        def rows_of(spec):
            # rows where no scenario threw any such wood (e.g. piling on with late_lit 0) are left out
            rows = [(lab, {k: agg[k].get(key) for k, _, _ in show}) for lab, key in spec]
            return [r for r in rows if any(v is not None for v in r[1].values())]

        panels = [("By behaviour", rows_of(behaviours)),
                  ("By when the wood landed", rows_of(timing))]
        chart_rewards(panels, show, os.path.join(DOCS_SIM, "reward_per_ember.svg"),
                      "Launch parameters and rules, median of %d seeds per scenario."
                      % len(SEEDS))

    if args.command in ("all", "testnet"):
        tseeds = [1, 2, 3, 4]
        res_bots = run_many([(prm_t, s, 0, MAIN_RULE) for s in tseeds], args.workers,
                            _task_testnet)
        res_judges = run_many([(prm_t, s, TESTNET_JUDGES, MAIN_RULE) for s in tseeds],
                              args.workers, _task_testnet)

        def medrun(rs):
            out = {}
            for key in rs[0]:
                if isinstance(rs[0][key], (int, float)) and not isinstance(rs[0][key], bool):
                    out[key] = med([r[key] for r in rs])
                elif rs[0][key] is None:
                    out[key] = med([r[key] for r in rs])
            return out

        tn = [("demo bots only", medrun(res_bots)),
              ("demo bots and %d judges" % TESTNET_JUDGES, medrun(res_judges))]
        blocks["testnet"] = md_testnet(tn, prm_t)
        bot_rows = []
        for name, kind, bal, size in TESTNET_BOTS:
            npes = [r["bots"][name]["npe"] for r in res_judges if r["bots"][name]["npe"] is not None]
            ends = [r["bots"][name]["end_over_start"] for r in res_judges]
            bot_rows.append([name, TESTNET_BOT_TEXT[name].split(":")[0], "{:,}".format(bal),
                             "{:,}".format(size) if size else "never throws",
                             pct(med(npes), 2, True) if npes else "n/a",
                             "%.3f" % med(ends)])
        blocks["testnet_bots"] = table(["Bot", "Behaviour", "Founding balance (EMBER)",
                                        "Typical throw (EMBER)", "Net reward per EMBER thrown",
                                        "Balance after %d days / founding" % TESTNET_DAYS],
                                       bot_rows)
        for label, r in tn:
            print("testnet %s: lit %.2f, pivotal %s, supply end %.3f, hearth end %.0f"
                  % (label, r["lit_rate"], r["pivotal"], r["supply_end"], r["hearth_end"]))

    if inject(os.path.join(ROOT, "docs", "SIMULATION.md"), blocks):
        print("updated docs/SIMULATION.md")
    print("done")


if __name__ == "__main__":
    main()
