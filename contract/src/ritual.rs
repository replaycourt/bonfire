//! The ritual: throwing wood, kindling, and settling the nights.
//!
//! Every ritual call first settles the nights that have ended (up to `max_catchup` of them), so
//! wood always lands on the night the clock says is burning. Every action checks everything first
//! and changes state only after all checks passed, so a refused action leaves no trace.
//!
//! Rounding (all integer, every division rounds down):
//! - weight of a throw: `below * early_bp + above * late_lit_bp`, exact; `early_bp` itself is
//!   `early_max_bp - (early_max_bp - 10000) * elapsed_ms / night_ms`, rounded up for the thrower;
//! - lit: `mint = target * mint_bp / 1e4`, `hearth_cut = mint * hearth_cut_bp / 1e4`, each share
//!   `(mint - hearth_cut) * weight / total_weight`; the shares' rounding dust is never minted;
//! - smoke: `burn = pile * smoke_bp / 1e4`, each return `(pile - burn) * wood / pile`; the returns'
//!   rounding dust goes to the hearth; `hearth_burn = hearth * hearth_burn_bp / 1e4`;
//! - target: grows by `target * grow_bp / 1e4`, shrinks by `target * shrink_bp / 1e4`.
//!
//! So every rounding goes against the throwers and never creates EMBER: splitting wood across
//! accounts can only lose a few base units, and supply = balances + pile + hearth always holds.

use crate::config::*;
use crate::events::{self, Kind, KindlingEvent, LitEvent, Logs, SmokeEvent, ThrowEvent, memo};
use crate::math::{bp_of, mul_div};
use crate::types::*;
use crate::{Bonfire, BonfireExt};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, assert_one_yocto, env, near};

#[near]
impl Bonfire {
    /// Throws `amount` of the caller's free EMBER on tonight's pile. Requires exactly 1 yoctoNEAR,
    /// like `ft_transfer`, so only a full-access key can risk the caller's wood. `night`, if given,
    /// must be tonight's number, as a guard against a transaction that lands a night late.
    #[payable]
    pub fn throw_wood(&mut self, amount: U128, night: Option<u32>) -> ThrowOutcome {
        assert_one_yocto();
        let actor = env::predecessor_account_id();
        let mut logs = Logs::new();
        self.catch_up(&mut logs);
        let clock = self.clock_night(env::block_timestamp_ms());
        if let Some(n) = night.filter(|&n| n != clock) {
            env::panic_str(&format!("the throw is for night {n}, but this is night {clock}"));
        }
        let out = self.do_throw(&actor, amount.0, &mut logs).unwrap_or_else(|e| env::panic_str(&e));
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

    /// Early factor in bp for wood landing `elapsed_ms` into a night: `early_max_bp` at the start,
    /// falling linearly to 10000 at the end.
    pub(crate) fn early_bp(&self, elapsed_ms: u64) -> u32 {
        let span = (self.cfg.early_max_bp - BP as u32) as u64;
        let elapsed = elapsed_ms.min(self.cfg.night_ms);
        self.cfg.early_max_bp - (span * elapsed / self.cfg.night_ms) as u32
    }

    /// Settles ended nights, oldest first. Only the first of them can have wood on it: nobody can
    /// throw on a night that has ended. Init checked that a full first night fits the log budget;
    /// every later (empty) night is settled only while its bound still fits.
    pub(crate) fn catch_up(&mut self, logs: &mut Logs) -> u32 {
        let clock = self.clock_night(env::block_timestamp_ms());
        if self.night >= clock {
            return 0;
        }
        let me = env::current_account_id();
        let mut done = 0;
        while self.night < clock && done < self.cfg.max_catchup {
            if done > 0 {
                let next = events::empty_night_bound(&me, clock, self.target, self.hearth, self.supply);
                if logs.bytes() + next > SETTLE_LOG_BUDGET {
                    break;
                }
            }
            self.settle_night(&me, logs);
            done += 1;
        }
        done
    }

    fn settle_night(&mut self, me: &AccountId, logs: &mut Logs) {
        let n = self.night;
        let (target, pile) = (self.target, self.pile);
        let accounts: Vec<AccountId> = (0..self.throwers)
            .map(|i| self.tonight.get(&i).cloned().unwrap_or_else(|| env::panic_str("thrower missing")))
            .collect();
        let mut log = NightLog {
            night: n,
            outcome: Outcome::Empty,
            target: U128(target),
            pile: U128(pile),
            minted: U128(0),
            hearth_cut: U128(0),
            unminted: U128(0),
            burned: U128(0),
            hearth_burned: U128(0),
            to_hearth: U128(0),
            target_next: U128(0),
            streak: 0,
            supply: U128(0),
            throwers: Vec::with_capacity(accounts.len()),
        };
        let (next, moved) = if pile > 0 && pile >= target {
            self.light(me, &accounts, &mut log, logs)
        } else {
            self.smoke(me, &accounts, &mut log, logs)
        };
        self.pile = 0;
        self.weight = 0;
        self.throwers = 0;
        self.target = next;
        log.target_next = U128(next);
        log.streak = self.streak;
        log.supply = U128(self.supply);
        self.push_history(HistoryRow { night: n, outcome: log.outcome, target, pile, moved, supply: self.supply });
        self.last = Some(LastNight { night: n, outcome: log.outcome, target: U128(target), pile: U128(pile) });
        self.logs.insert(n % self.cfg.log_keep, log);
        self.night += 1;
    }

    /// Lit: every thrower gets the wood back plus a share of the mint by weight; the hearth gets
    /// its cut; the target grows. Returns the next target and what was minted.
    fn light(&mut self, me: &AccountId, accounts: &[AccountId], log: &mut NightLog, logs: &mut Logs) -> (u128, u128) {
        let (n, target, pile, total_weight) = (self.night, self.target, self.pile, self.weight);
        let mint = bp_of(target, self.cfg.mint_bp).min(SUPPLY_CAP - self.supply);
        let cut = bp_of(mint, self.cfg.hearth_cut_bp);
        let pool = mint - cut;
        let mut shares = 0;
        for a in accounts {
            let h = self.holders.get_mut(a).unwrap_or_else(|| env::panic_str("thrower record missing"));
            let share = if total_weight > 0 { mul_div(pool, h.weight, total_weight) } else { 0 };
            let paid = h.wood + share;
            log.throwers.push(ThrowerLog {
                account: a.clone(),
                wood: U128(h.wood),
                weight: U128(h.weight),
                paid: U128(paid),
            });
            h.balance += paid;
            h.wood = 0;
            h.weight = 0;
            shares += share;
            logs.transfer(me, a, paid, None);
        }
        let minted = cut + shares;
        self.balances += pile + shares;
        self.hearth += cut;
        self.supply += minted;
        self.streak += 1;
        let r = &mut self.records;
        r.total_minted = U128(r.total_minted.0 + minted);
        r.longest_streak = r.longest_streak.max(self.streak);
        r.tallest_fire = U128(r.tallest_fire.0.max(target));
        r.nights_lit += 1;
        let next = target.saturating_add(bp_of(target, self.cfg.grow_bp)).min(SUPPLY_CAP);
        log.outcome = Outcome::Lit;
        log.minted = U128(minted);
        log.hearth_cut = U128(cut);
        log.unminted = U128(pool - shares);
        logs.mint(me, minted, Some(&memo(n, "lit")));
        logs.bonfire(
            Kind::Lit,
            &LitEvent {
                night: n,
                target: U128(target),
                pile: U128(pile),
                throwers: accounts.len() as u32,
                minted: U128(minted),
                hearth_cut: U128(cut),
                unminted: U128(pool - shares),
                target_next: U128(next),
                streak: self.streak,
                supply: U128(self.supply),
            },
        );
        (next, minted)
    }

    /// Smoke (or an empty night): part of the pile burns and the rest goes back pro rata, the
    /// hearth burns its slice, the target shrinks. Returns the next target and what was burned.
    fn smoke(&mut self, me: &AccountId, accounts: &[AccountId], log: &mut NightLog, logs: &mut Logs) -> (u128, u128) {
        let (n, target, pile) = (self.night, self.target, self.pile);
        let burn = bp_of(pile, self.cfg.smoke_bp);
        let back_pool = pile - burn;
        let mut returned = 0;
        for a in accounts {
            let h = self.holders.get_mut(a).unwrap_or_else(|| env::panic_str("thrower record missing"));
            let back = mul_div(back_pool, h.wood, pile);
            log.throwers.push(ThrowerLog {
                account: a.clone(),
                wood: U128(h.wood),
                weight: U128(h.weight),
                paid: U128(back),
            });
            h.balance += back;
            h.wood = 0;
            h.weight = 0;
            returned += back;
            logs.transfer(me, a, back, None);
        }
        let to_hearth = back_pool - returned;
        let hearth_burned = bp_of(self.hearth, self.cfg.hearth_burn_bp);
        self.hearth = self.hearth - hearth_burned + to_hearth;
        self.balances += returned;
        let burned = burn + hearth_burned;
        self.supply -= burned;
        self.streak = 0;
        let r = &mut self.records;
        r.total_burned = U128(r.total_burned.0 + burned);
        if pile == 0 {
            r.nights_empty += 1;
        } else {
            r.nights_smoke += 1;
        }
        let next = (target - bp_of(target, self.cfg.shrink_bp)).max(self.cfg.target_min.0);
        log.outcome = if pile == 0 { Outcome::Empty } else { Outcome::Smoke };
        log.burned = U128(burned);
        log.hearth_burned = U128(hearth_burned);
        log.to_hearth = U128(to_hearth);
        logs.burn(me, burn, Some(&memo(n, "smoke")));
        logs.burn(me, hearth_burned, Some(&memo(n, "hearth smoke")));
        logs.bonfire(
            Kind::Smoke,
            &SmokeEvent {
                night: n,
                target: U128(target),
                pile: U128(pile),
                throwers: accounts.len() as u32,
                burned: U128(burn),
                returned: U128(returned),
                to_hearth: U128(to_hearth),
                hearth_burned: U128(hearth_burned),
                target_next: U128(next),
                supply: U128(self.supply),
            },
        );
        (next, burned)
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
        let Some(h) = self.holders.get(actor) else {
            return Err(format!("The account {actor} is not registered"));
        };
        if h.balance < amount {
            return Err("not enough free EMBER".into());
        }
        let first = h.wood == 0;
        if first && self.throwers >= self.cfg.max_throwers_per_night {
            return Err(format!(
                "tonight's fire has room for {} throwers and all of them are taken; those already at it can still add wood",
                self.cfg.max_throwers_per_night
            ));
        }
        let early = self.early_bp(now - self.night_start(n));
        let below = if self.pile >= self.target { 0 } else { amount.min(self.target - self.pile) };
        let late = amount - below;
        let weight = below * early as u128 + late * self.cfg.late_lit_bp as u128;

        let h = self.holders.get_mut(actor).unwrap_or_else(|| env::abort());
        h.balance -= amount;
        h.wood += amount;
        h.weight += weight;
        let (wood, weight_total) = (h.wood, h.weight);
        self.balances -= amount;
        self.pile += amount;
        self.weight += weight;
        if first {
            self.tonight.insert(self.throwers, actor.clone());
            self.throwers += 1;
        }
        let me = env::current_account_id();
        logs.transfer(actor, &me, amount, Some("throw"));
        logs.bonfire(
            Kind::Throw,
            &ThrowEvent {
                night: n,
                account: actor,
                amount: U128(amount),
                weight: U128(weight),
                early_bp: early,
                late: U128(late),
                pile: U128(self.pile),
                target: U128(self.target),
            },
        );
        Ok(ThrowOutcome {
            night: n,
            amount: U128(amount),
            weight: U128(weight),
            wood: U128(wood),
            weight_total: U128(weight_total),
            pile: U128(self.pile),
            target: U128(self.target),
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
