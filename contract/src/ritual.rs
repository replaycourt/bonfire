//! The ritual: throwing wood, kindling, settling the nights, and collecting what they owe.
//!
//! Every ritual call first settles the nights that have ended (up to `max_catchup` of them), so
//! wood always lands on the night the clock says is burning. Settling a night records only its
//! aggregates; each thrower's wood and share are credited when the thrower next acts, throws,
//! transfers or claims, or when anyone calls `collect` for them. `ft_balance_of` counts that
//! credit already. A holder can only throw on the burning night, so it owes or is owed for at
//! most one night: its pending entry is collected before its next throw.
//!
//! The arithmetic follows `sim/bonfire_sim.py` (rule "pooled"), every division rounding down:
//! - weight: the night is cut into `pool_windows` windows by the clock. A window's wood covers the
//!   slice of the pile above all earlier windows' wood; below the target it weighs the integral of
//!   the factor that falls linearly from `early_max_bp` (empty pile) to 10000 (target), above it
//!   `late_lit_bp` per unit. Each thrower gets the window's weight times its wood over the
//!   window's wood (`math::window_weights`);
//! - lit: `mint = target * mint_bp / 1e4`, `hearth_cut = mint * hearth_cut_bp / 1e4`; each thrower
//!   collects its wood plus `(mint - hearth_cut) * weight / total_weight`;
//! - smoked: `burn = pile * smoke_bp / 1e4`; each thrower collects `wood * (pile - burn) / pile`;
//!   the hearth burns `min(hearth * hearth_burn_bp / 1e4, target * mint_bp / 1e4)`;
//! - cold (no wood): nothing burns;
//! - target: `target * (1e4 + grow_bp) / 1e4` after a lit night, `target * (1e4 - shrink_bp) / 1e4`
//!   otherwise, then at most `(supply - hearth - pile) * target_cap_bp / 1e4`, then at least
//!   `target_min` (the floor wins).
//!
//! Rounding dust of the shares and returns goes to the hearth, as in the model, but only once the
//! night's last thrower has collected: before that nobody knows how much it is.

use crate::config::*;
use crate::events::{self, ColdEvent, Kind, KindlingEvent, LitEvent, Logs, SmokedEvent, ThrowEvent, memo};
use crate::math::{bp_of, mul_div, window_weights};
use crate::types::*;
use crate::{Bonfire, BonfireExt};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, assert_one_yocto, env, near};

#[near]
impl Bonfire {
    /// Throws `amount` of the caller's free EMBER on tonight's pile. Requires exactly 1 yoctoNEAR,
    /// like `ft_transfer`, so only a full-access key can risk the caller's wood. `night` must be
    /// tonight's number (`state().clock_night`), so a transaction that lands late fails.
    #[payable]
    pub fn throw_wood(&mut self, amount: U128, night: u32) -> ThrowOutcome {
        assert_one_yocto();
        let actor = env::predecessor_account_id();
        let mut logs = Logs::new();
        self.catch_up(&mut logs);
        let collected = self.credit(&actor, &mut logs).1;
        self.check_night(night).unwrap_or_else(|e| env::panic_str(&e));
        let mut out = self.do_throw(&actor, amount.0, &mut logs).unwrap_or_else(|e| env::panic_str(&e));
        out.collected = U128(collected);
        logs.emit();
        out
    }

    /// Hands `kindling` EMBER from the hearth to the caller, once, if the caller never held EMBER.
    /// The contract registers an unknown caller at its own cost (up to `max_accounts`).
    pub fn claim_kindling(&mut self) -> KindlingOutcome {
        let actor = env::predecessor_account_id();
        let mut logs = Logs::new();
        self.catch_up(&mut logs);
        let out = self.do_claim_kindling(&actor, &mut logs).unwrap_or_else(|e| env::panic_str(&e));
        logs.emit();
        out
    }

    /// Settles the nights that have ended, up to `max_catchup` per call, fewer if the next night's
    /// events would not fit in the call's logs. Anyone may call it; calling early does nothing.
    pub fn settle(&mut self) -> SettleOutcome {
        let mut logs = Logs::new();
        let settled = self.catch_up(&mut logs);
        logs.emit();
        let clock = self.clock_night(env::block_timestamp_ms());
        SettleOutcome {
            settled,
            night: self.night,
            nights_due: clock - self.night,
            ends_ms: self.night_end(self.night),
        }
    }

    /// Credits `account_id` with what a settled night owes it: its wood back plus its share on a
    /// lit night, the unburned part on a smoky one. Anyone may call it for anyone; it settles
    /// ended nights first. Collecting nothing is not an error.
    pub fn collect(&mut self, account_id: AccountId) -> CollectOutcome {
        let mut logs = Logs::new();
        self.catch_up(&mut logs);
        let (night, amount) = self.credit(&account_id, &mut logs);
        logs.emit();
        CollectOutcome { account: account_id, night, amount: U128(amount) }
    }
}

impl Bonfire {
    /// The night the clock says is burning. Night 1 starts at the init block.
    pub(crate) fn clock_night(&self, now_ms: u64) -> u32 {
        let n = now_ms.saturating_sub(self.genesis_ms) / self.cfg.night_ms + 1;
        n.min(u32::MAX as u64) as u32
    }

    pub(crate) fn night_start(&self, n: u32) -> u64 {
        self.genesis_ms + (n as u64 - 1) * self.cfg.night_ms
    }

    pub(crate) fn night_end(&self, n: u32) -> u64 {
        self.genesis_ms + n as u64 * self.cfg.night_ms
    }

    /// The pooling window wood landing `elapsed_ms` into a night falls in.
    pub(crate) fn window_at(&self, elapsed_ms: u64) -> u8 {
        let w =
            elapsed_ms.min(self.cfg.night_ms - 1) as u128 * self.cfg.pool_windows as u128 / self.cfg.night_ms as u128;
        w as u8
    }

    pub(crate) fn check_night(&self, named: u32) -> Result<(), String> {
        let clock = self.clock_night(env::block_timestamp_ms());
        if named == clock { Ok(()) } else { Err(format!("the throw is for night {named}, but this is night {clock}")) }
    }

    /// Settles ended nights, oldest first. Only the first of them can have wood on it: nobody can
    /// throw on a night that has ended. A night's events do not depend on its number of throwers,
    /// so the first always fits the budget; later (cold) nights are settled while they still fit.
    pub(crate) fn catch_up(&mut self, logs: &mut Logs) -> u32 {
        let clock = self.clock_night(env::block_timestamp_ms());
        if self.night >= clock {
            return 0;
        }
        let me = env::current_account_id();
        let mut done = 0;
        while self.night < clock && done < self.cfg.max_catchup {
            if done > 0 && logs.bytes() + events::cold_night_bound(clock, self.target) > SETTLE_LOG_BUDGET {
                break;
            }
            self.settle_night(&me, logs);
            done += 1;
        }
        done
    }

    fn settle_night(&mut self, me: &AccountId, logs: &mut Logs) {
        let n = self.night;
        let (target, pile, throwers) = (self.target, self.pile, self.throwers);
        let windows = if pile > 0 {
            window_weights(&self.windows, target, self.cfg.early_max_bp, self.cfg.late_lit_bp)
        } else {
            Vec::new()
        };
        let firestarter = self.firestarter.take();
        let last_log = self.last_log.take();
        let mut log = NightLog {
            night: n,
            outcome: Outcome::Cold,
            target,
            pile,
            throwers,
            minted: 0,
            hearth_cut: 0,
            burned: 0,
            hearth_burned: 0,
            target_next: 0,
            streak: 0,
            supply: 0,
            firestarter: None,
            last_log: None,
            windows: windows.clone(),
        };
        self.pile = 0;
        self.windows.iter_mut().for_each(|w| *w = 0);
        self.throwers = 0;
        let moved;
        let rule_next;
        if pile > 0 && pile >= target {
            let mint = bp_of(target, self.cfg.mint_bp).min(SUPPLY_CAP - self.supply);
            let cut = bp_of(mint, self.cfg.hearth_cut_bp);
            let shared = mint - cut;
            let weight: u128 = windows.iter().map(|w| w.1).sum();
            self.supply += mint;
            self.hearth += cut;
            self.owe(
                n,
                Owed {
                    outcome: Outcome::Lit,
                    pile,
                    pool: shared,
                    weight,
                    windows,
                    left: throwers,
                    remaining: pile + shared,
                },
            );
            self.streak += 1;
            let r = &mut self.records;
            r.total_minted = U128(r.total_minted.0 + mint);
            r.longest_streak = r.longest_streak.max(self.streak);
            r.tallest_fire = U128(r.tallest_fire.0.max(target));
            r.nights_lit += 1;
            rule_next = mul_div(target, BP + self.cfg.grow_bp as u128, BP);
            log.outcome = Outcome::Lit;
            log.minted = mint;
            log.hearth_cut = cut;
            moved = mint;
            logs.mint(me, mint, Some(&memo(n, "lit")));
            let next = self.next_target(rule_next);
            logs.bonfire(
                Kind::Lit,
                &LitEvent {
                    night: n,
                    target: U128(target),
                    pile: U128(pile),
                    throwers,
                    minted: U128(mint),
                    hearth_cut: U128(cut),
                    shared: U128(shared),
                    weight: U128(weight),
                    target_next: U128(next),
                    streak: self.streak,
                    supply: U128(self.supply),
                    firestarter: firestarter.as_ref(),
                    last_log: last_log.as_ref(),
                },
            );
        } else if pile > 0 {
            let burn = bp_of(pile, self.cfg.smoke_bp);
            let back = pile - burn;
            let hearth_burned = bp_of(self.hearth, self.cfg.hearth_burn_bp).min(bp_of(target, self.cfg.mint_bp));
            self.hearth -= hearth_burned;
            self.supply -= burn + hearth_burned;
            self.owe(
                n,
                Owed {
                    outcome: Outcome::Smoked,
                    pile,
                    pool: back,
                    weight: 0,
                    windows: Vec::new(),
                    left: throwers,
                    remaining: back,
                },
            );
            self.streak = 0;
            let r = &mut self.records;
            r.total_burned = U128(r.total_burned.0 + burn + hearth_burned);
            r.nights_smoked += 1;
            rule_next = mul_div(target, BP - self.cfg.shrink_bp as u128, BP);
            log.outcome = Outcome::Smoked;
            log.burned = burn + hearth_burned;
            log.hearth_burned = hearth_burned;
            moved = burn + hearth_burned;
            logs.burn(me, burn, Some(&memo(n, "smoke")));
            logs.burn(me, hearth_burned, Some(&memo(n, "hearth smoke")));
            let next = self.next_target(rule_next);
            logs.bonfire(
                Kind::Smoked,
                &SmokedEvent {
                    night: n,
                    target: U128(target),
                    pile: U128(pile),
                    short: U128(target - pile),
                    throwers,
                    burned: U128(burn + hearth_burned),
                    back: U128(back),
                    hearth_burned: U128(hearth_burned),
                    target_next: U128(next),
                    supply: U128(self.supply),
                    firestarter: firestarter.as_ref(),
                },
            );
        } else {
            self.streak = 0;
            self.records.nights_cold += 1;
            rule_next = mul_div(target, BP - self.cfg.shrink_bp as u128, BP);
            moved = 0;
            let next = self.next_target(rule_next);
            logs.bonfire(Kind::Cold, &ColdEvent { night: n, target: U128(target), target_next: U128(next) });
        }
        let next = self.next_target(rule_next);
        self.target = next;
        log.target_next = next;
        log.streak = self.streak;
        log.supply = self.supply;
        log.firestarter = firestarter;
        log.last_log = last_log;
        self.push_history(HistoryRow { night: n, outcome: log.outcome, target, pile, moved, supply: self.supply });
        self.last = Some(LastNight { night: n, outcome: log.outcome, target: U128(target), pile: U128(pile) });
        self.logs.insert(n % self.cfg.log_keep, log);
        self.night += 1;
    }

    /// The rule's next target, capped at `target_cap_bp` of the free supply (the pile of the night
    /// being settled is already owed to its throwers, so it is free), never below `target_min`.
    fn next_target(&self, rule: u128) -> u128 {
        let mut next = rule.min(SUPPLY_CAP);
        if self.cfg.target_cap_bp > 0 {
            next = next.min(bp_of(self.supply - self.hearth - self.pile, self.cfg.target_cap_bp));
        }
        next.max(self.cfg.target_min.0)
    }

    fn owe(&mut self, night: u32, o: Owed) {
        self.owed += o.remaining;
        self.owed_nights += 1;
        self.owed_by_night.insert(night, o);
    }

    fn push_history(&mut self, row: HistoryRow) {
        let index = (row.night - 1) / HISTORY_BUCKET;
        let slot = index % (self.cfg.history_keep / HISTORY_BUCKET);
        if (row.night - 1).is_multiple_of(HISTORY_BUCKET) {
            self.history.insert(slot, vec![row]);
        } else {
            let bucket = self.history.get_mut(&slot).unwrap_or_else(|| env::panic_str("history bucket missing"));
            bucket.push(row);
        }
    }

    /// What a settled night owes the holder of `pending`, from the night's record.
    pub(crate) fn credit_of(o: &Owed, p: &Pending) -> u128 {
        let wood = p.total();
        match o.outcome {
            Outcome::Lit => {
                let weight: u128 = p
                    .wood
                    .iter()
                    .map(|&(w, a)| o.windows.get(w as usize).map_or(0, |&(x, ws)| mul_div(ws, a, x)))
                    .sum();
                wood + if o.weight > 0 { mul_div(o.pool, weight, o.weight) } else { 0 }
            }
            _ => mul_div(wood, o.pool, o.pile),
        }
    }

    /// Credits `account` with what its settled night owes it and deletes the night's record after
    /// its last thrower, moving the rounding dust to the hearth. Returns (night, amount).
    pub(crate) fn credit(&mut self, account: &AccountId, logs: &mut Logs) -> (Option<u32>, u128) {
        let Some(p) = self.holders.get(account).and_then(|h| h.pending.clone()) else {
            return (None, 0);
        };
        if p.night >= self.night {
            return (None, 0);
        }
        let n = p.night;
        let o = self.owed_by_night.get_mut(&n).unwrap_or_else(|| env::panic_str("owed record missing"));
        let amount = Self::credit_of(o, &p);
        o.left -= 1;
        o.remaining -= amount;
        let dust = if o.left == 0 { Some(o.remaining) } else { None };
        if let Some(dust) = dust {
            self.owed_by_night.remove(&n);
            self.owed_nights -= 1;
            self.hearth += dust;
            self.owed -= dust;
        }
        let h = self.holders.get_mut(account).unwrap_or_else(|| env::abort());
        h.balance += amount;
        h.pending = None;
        self.balances += amount;
        self.owed -= amount;
        logs.transfer(&env::current_account_id(), account, amount, Some(&memo(n, "collect")));
        (Some(n), amount)
    }

    pub(crate) fn do_throw(
        &mut self,
        actor: &AccountId,
        amount: u128,
        logs: &mut Logs,
    ) -> Result<ThrowOutcome, String> {
        let now = env::block_timestamp_ms();
        let n = self.night;
        if n < self.clock_night(now) {
            return Err("ended nights are still waiting to be settled: call settle, then throw again".into());
        }
        if amount < self.cfg.min_throw.0 {
            return Err(format!("the smallest throw is {} base units", self.cfg.min_throw.0));
        }
        if !self.holders.contains_key(actor) {
            return Err(format!("The account {actor} is not registered"));
        }
        let collected = self.credit(actor, logs).1;
        let h = self.holders.get(actor).unwrap_or_else(|| env::abort());
        if h.balance < amount {
            return Err("not enough free EMBER".into());
        }
        let first = h.pending.is_none();
        let window = self.window_at(now - self.night_start(n));

        let h = self.holders.get_mut(actor).unwrap_or_else(|| env::abort());
        h.balance -= amount;
        let p = h.pending.get_or_insert_with(|| Pending { night: n, wood: Vec::new() });
        p.add(window, amount);
        let wood = p.total();
        let before = self.pile;
        self.balances -= amount;
        self.pile += amount;
        self.windows[window as usize] += amount;
        if first {
            self.throwers += 1;
        }
        let starter = self.firestarter.is_none();
        if starter {
            self.firestarter = Some(actor.clone());
        }
        let crossed = before < self.target && self.pile >= self.target;
        if crossed {
            self.last_log = Some(LastLog { account: actor.clone(), amount: U128(amount) });
        }
        let feed = RecentThrow {
            night: n,
            window,
            account: actor.clone(),
            amount: U128(amount),
            pile: U128(self.pile),
            at_ms: now,
        };
        let mut recent = self.recent.get().clone().unwrap_or_default();
        if recent.len() >= RECENT_THROWS {
            recent.remove(0);
        }
        recent.push(feed);
        self.recent.set(Some(recent));
        let me = env::current_account_id();
        logs.transfer(actor, &me, amount, Some("throw"));
        logs.bonfire(
            Kind::Throw,
            &ThrowEvent {
                night: n,
                window,
                account: actor,
                amount: U128(amount),
                pile: U128(self.pile),
                target: U128(self.target),
                firestarter: starter,
                last_log: crossed,
            },
        );
        Ok(ThrowOutcome {
            night: n,
            window,
            amount: U128(amount),
            wood: U128(wood),
            pile: U128(self.pile),
            target: U128(self.target),
            collected: U128(collected),
        })
    }

    pub(crate) fn do_claim_kindling(&mut self, actor: &AccountId, logs: &mut Logs) -> Result<KindlingOutcome, String> {
        let me = env::current_account_id();
        if actor == &me {
            return Err("the hearth cannot give kindling to itself".into());
        }
        let clock = self.clock_night(env::block_timestamp_ms());
        let claims = if self.kindling_night == clock { self.kindling_claims } else { 0 };
        if claims >= self.cfg.kindling_per_night {
            return Err("tonight's kindling is all handed out; come back next night".into());
        }
        let k = self.cfg.kindling.0;
        if self.hearth < k {
            return Err("the hearth is too low to hand out kindling".into());
        }
        let known = self.holders.get(actor).map(|h| h.flags);
        match known {
            Some(flags) if flags & HELD != 0 => {
                return Err("kindling is only for accounts that never held EMBER".into());
            }
            None if self.sponsored >= self.cfg.max_accounts => {
                return Err(
                    "the contract pays storage for no more accounts; register with storage_deposit first".into()
                );
            }
            _ => {}
        }

        if known.is_none() {
            self.holders.insert(actor.clone(), Holder { flags: SPONSORED, ..Default::default() });
            self.sponsored += 1;
        }
        let h = self.holders.get_mut(actor).unwrap_or_else(|| env::abort());
        h.balance += k;
        h.flags |= HELD | KINDLED;
        self.hearth -= k;
        self.balances += k;
        self.kindling_night = clock;
        self.kindling_claims = claims + 1;
        self.records.kindling_claims += 1;
        let left = self.cfg.kindling_per_night - self.kindling_claims;
        logs.transfer(&me, actor, k, Some("kindling"));
        logs.bonfire(
            Kind::Kindling,
            &KindlingEvent {
                night: clock,
                account: actor,
                amount: U128(k),
                hearth: U128(self.hearth),
                left_tonight: left,
            },
        );
        Ok(KindlingOutcome { night: clock, amount: U128(k), left_tonight: left })
    }
}
