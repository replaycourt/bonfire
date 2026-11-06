//! Read-only methods for clients. Amounts are base units as decimal strings.

use crate::config::*;
use crate::types::*;
use crate::{Bonfire, BonfireExt, signing_message};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, env, near};

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ConfigView {
    pub version: String,
    pub config: Config,
    pub founders: Vec<Founder>,
    pub genesis_ms: u64,
    pub genesis_supply: U128,
    pub supply_cap: U128,
    /// Storage one account record takes, and what registering an account costs in yoctoNEAR.
    pub account_storage_bytes: u64,
    pub account_storage_cost: U128,
    /// Highest `max_throwers_per_night` this deployment could have been given (log budget).
    pub max_throwers_limit: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct StateView {
    /// The open night: its pile is the one shown.
    pub night: u32,
    pub night_start_ms: u64,
    pub night_end_ms: u64,
    pub now_ms: u64,
    /// True once the open night has ended: `settle` (or any ritual call) would settle it.
    pub due: bool,
    /// Ended nights not settled yet.
    pub nights_due: u32,
    /// The night the clock says is burning. Actions for `act` name this night.
    pub clock_night: u32,
    pub target: U128,
    pub pile: U128,
    pub throwers: u32,
    pub max_throwers: u32,
    /// Sum of the weights on the pile.
    pub weight: U128,
    /// The pile has reached the target: new wood counts with `late_lit_bp`.
    pub reached: bool,
    /// Early factor wood landing now would get (below the target).
    pub early_bp_now: u32,
    pub streak: u32,
    pub records: Records,
    pub hearth: U128,
    pub supply: U128,
    pub kindling_left_tonight: u32,
    pub accounts_sponsored: u32,
    pub max_accounts: u32,
    pub last: Option<LastNight>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThrowerView {
    pub account: AccountId,
    pub wood: U128,
    pub weight: U128,
    /// Wood that came back (all of it on a lit night).
    pub back: U128,
    /// Newly minted EMBER this thrower got.
    pub reward: U128,
    /// Wood that burned.
    pub lost: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NightView {
    pub night: u32,
    pub outcome: Outcome,
    pub start_ms: u64,
    pub end_ms: u64,
    pub target: U128,
    pub pile: U128,
    pub minted: U128,
    pub hearth_cut: U128,
    pub unminted: U128,
    pub burned: U128,
    pub hearth_burned: U128,
    pub to_hearth: U128,
    /// None while the night is open.
    pub target_next: Option<U128>,
    pub streak: u32,
    pub supply: Option<U128>,
    pub throwers: Vec<ThrowerView>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryView {
    pub night: u32,
    pub target: U128,
    pub pile: U128,
    pub outcome: Outcome,
    pub minted: U128,
    pub burned: U128,
    /// Total supply after the night.
    pub supply: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HolderView {
    pub account: AccountId,
    pub registered: bool,
    /// Free EMBER (`ft_balance_of`).
    pub balance: U128,
    /// Wood on the open night's pile and its weight.
    pub wood: U128,
    pub weight: U128,
    pub nonce: u64,
    pub sponsored: bool,
    pub held: bool,
    pub kindled: bool,
    pub may_take_kindling: bool,
}

/// Where all the EMBER is. `balanced` and `ledger` must always be true.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditView {
    pub supply: U128,
    /// Sum of free balances, tracked on every change.
    pub balances: U128,
    pub pile: U128,
    /// The pile recomputed from tonight's throwers.
    pub pile_recomputed: U128,
    pub hearth: U128,
    /// supply == balances + pile + hearth, and the pile equals its recomputation.
    pub balanced: bool,
    pub genesis: U128,
    pub minted: U128,
    pub burned: U128,
    /// supply == genesis + minted - burned.
    pub ledger: bool,
    pub storage_bytes: u64,
    /// NEAR the contract holds and what its storage needs (yoctoNEAR).
    pub near_balance: U128,
    pub storage_stake: U128,
}

#[near]
impl Bonfire {
    pub fn config(&self) -> ConfigView {
        let me = env::current_account_id();
        ConfigView {
            version: env!("CARGO_PKG_VERSION").to_string(),
            config: self.cfg.clone(),
            founders: self.founders.get().clone().unwrap_or_default(),
            genesis_ms: self.genesis_ms,
            genesis_supply: U128(self.genesis_supply),
            supply_cap: U128(SUPPLY_CAP),
            account_storage_bytes: self.account_bytes,
            account_storage_cost: U128(self.storage_cost().as_yoctonear()),
            max_throwers_limit: max_throwers_limit(&me),
        }
    }

    pub fn state(&self) -> StateView {
        let now = env::block_timestamp_ms();
        let clock = self.clock_night(now);
        let claims = if self.kindling_night == clock { self.kindling_claims } else { 0 };
        let kindling_left = if self.hearth < self.cfg.kindling.0 {
            0
        } else {
            let affordable = (self.hearth / self.cfg.kindling.0).min(u32::MAX as u128) as u32;
            self.cfg.kindling_per_night.saturating_sub(claims).min(affordable)
        };
        StateView {
            night: self.night,
            night_start_ms: self.night_start(self.night),
            night_end_ms: self.night_end(self.night),
            now_ms: now,
            due: clock > self.night,
            nights_due: clock - self.night,
            clock_night: clock,
            target: U128(self.target),
            pile: U128(self.pile),
            throwers: self.throwers,
            max_throwers: self.cfg.max_throwers_per_night,
            weight: U128(self.weight),
            reached: self.pile >= self.target,
            early_bp_now: self.early_bp(now.saturating_sub(self.night_start(clock))),
            streak: self.streak,
            records: self.records.clone(),
            hearth: U128(self.hearth),
            supply: U128(self.supply),
            kindling_left_tonight: kindling_left,
            accounts_sponsored: self.sponsored,
            max_accounts: self.cfg.max_accounts,
            last: self.last.clone(),
        }
    }

    pub fn records(&self) -> Records {
        self.records.clone()
    }

    /// The open night with its throwers so far, or one of the last `log_keep` settled nights.
    pub fn night(&self, n: u32) -> Option<NightView> {
        if n == self.night {
            let throwers = self
                .tonight_accounts()
                .into_iter()
                .map(|a| {
                    let h = self.holders.get(&a).cloned().unwrap_or_default();
                    ThrowerView {
                        account: a,
                        wood: U128(h.wood),
                        weight: U128(h.weight),
                        back: U128(0),
                        reward: U128(0),
                        lost: U128(0),
                    }
                })
                .collect();
            return Some(NightView {
                night: n,
                outcome: Outcome::Open,
                start_ms: self.night_start(n),
                end_ms: self.night_end(n),
                target: U128(self.target),
                pile: U128(self.pile),
                minted: U128(0),
                hearth_cut: U128(0),
                unminted: U128(0),
                burned: U128(0),
                hearth_burned: U128(0),
                to_hearth: U128(0),
                target_next: None,
                streak: self.streak,
                supply: None,
                throwers,
            });
        }
        if n == 0 || n > self.night {
            return None;
        }
        let log = self.logs.get(&(n % self.cfg.log_keep)).filter(|l| l.night == n)?;
        let lit = log.outcome == Outcome::Lit;
        let throwers = log
            .throwers
            .iter()
            .map(|t| {
                let (wood, paid) = (t.wood.0, t.paid.0);
                ThrowerView {
                    account: t.account.clone(),
                    wood: t.wood,
                    weight: t.weight,
                    back: U128(if lit { wood } else { paid }),
                    reward: U128(if lit { paid - wood } else { 0 }),
                    lost: U128(if lit { 0 } else { wood - paid }),
                }
            })
            .collect();
        Some(NightView {
            night: n,
            outcome: log.outcome,
            start_ms: self.night_start(n),
            end_ms: self.night_end(n),
            target: log.target,
            pile: log.pile,
            minted: log.minted,
            hearth_cut: log.hearth_cut,
            unminted: log.unminted,
            burned: log.burned,
            hearth_burned: log.hearth_burned,
            to_hearth: log.to_hearth,
            target_next: Some(log.target_next),
            streak: log.streak,
            supply: Some(log.supply),
            throwers,
        })
    }

    /// One row per settled night, oldest first, from `from` (default: the oldest kept) for up to
    /// `limit` rows (default 100, at most 500). The last `history_keep` nights are kept (at least
    /// `history_keep - 31`: rows go in buckets of 32 and the oldest bucket is dropped whole).
    pub fn history(&self, from: Option<u32>, limit: Option<u32>) -> Vec<HistoryView> {
        let last = self.night - 1;
        if last == 0 {
            return Vec::new();
        }
        let first = self.oldest_history_night();
        let from = from.unwrap_or(first).max(first);
        let limit = limit.unwrap_or(100).min(MAX_HISTORY_PAGE);
        let buckets = self.cfg.history_keep / HISTORY_BUCKET;
        let mut rows = Vec::new();
        let mut n = from;
        while n <= last && (rows.len() as u32) < limit {
            let slot = (n - 1) / HISTORY_BUCKET % buckets;
            let Some(bucket) = self.history.get(&slot) else { break };
            let Some(r) = bucket.get(((n - 1) % HISTORY_BUCKET) as usize).filter(|r| r.night == n) else { break };
            let lit = r.outcome == Outcome::Lit;
            rows.push(HistoryView {
                night: n,
                target: U128(r.target),
                pile: U128(r.pile),
                outcome: r.outcome,
                minted: U128(if lit { r.moved } else { 0 }),
                burned: U128(if lit { 0 } else { r.moved }),
                supply: U128(r.supply),
            });
            n += 1;
        }
        rows
    }

    pub fn holder(&self, account_id: AccountId) -> HolderView {
        let h = self.holders.get(&account_id);
        let flags = h.map_or(0, |h| h.flags);
        HolderView {
            registered: h.is_some(),
            balance: U128(h.map_or(0, |h| h.balance)),
            wood: U128(h.map_or(0, |h| h.wood)),
            weight: U128(h.map_or(0, |h| h.weight)),
            nonce: h.map_or(0, |h| h.nonce),
            sponsored: flags & SPONSORED != 0,
            held: flags & HELD != 0,
            kindled: flags & KINDLED != 0,
            may_take_kindling: flags & HELD == 0 && account_id != env::current_account_id(),
            account: account_id,
        }
    }

    /// Checks that no EMBER appeared or vanished: anyone can call it at any time.
    pub fn audit(&self) -> AuditView {
        let recomputed: u128 = self.tonight_accounts().iter().filter_map(|a| self.holders.get(a)).map(|h| h.wood).sum();
        let sum = self.balances + self.pile + self.hearth;
        let (minted, burned) = (self.records.total_minted.0, self.records.total_burned.0);
        AuditView {
            supply: U128(self.supply),
            balances: U128(self.balances),
            pile: U128(self.pile),
            pile_recomputed: U128(recomputed),
            hearth: U128(self.hearth),
            balanced: sum == self.supply && recomputed == self.pile,
            genesis: U128(self.genesis_supply),
            minted: U128(minted),
            burned: U128(burned),
            ledger: self.genesis_supply + minted == self.supply + burned,
            storage_bytes: env::storage_usage(),
            near_balance: U128(env::account_balance().as_yoctonear() + env::account_locked_balance().as_yoctonear()),
            storage_stake: U128(env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128),
        }
    }

    /// The exact text a browser key signs for `act`.
    pub fn signing_text(&self, nonce: u64, action: String) -> String {
        signing_message(env::current_account_id().as_str(), nonce, &action)
    }
}

impl Bonfire {
    fn tonight_accounts(&self) -> Vec<AccountId> {
        (0..self.throwers).filter_map(|i| self.tonight.get(&i).cloned()).collect()
    }

    /// The oldest night `history` still has.
    pub(crate) fn oldest_history_night(&self) -> u32 {
        let last = self.night - 1;
        let buckets = self.cfg.history_keep / HISTORY_BUCKET;
        let newest = (last.max(1) - 1) / HISTORY_BUCKET;
        newest.saturating_sub(buckets - 1) * HISTORY_BUCKET + 1
    }
}
