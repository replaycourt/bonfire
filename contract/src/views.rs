//! Read-only methods for clients. Amounts are base units as decimal strings.

use crate::config::*;
use crate::math::{mul_div, window_weights};
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
    /// Storage the largest account record takes, and what registering an account costs in yoctoNEAR.
    pub account_storage_bytes: u64,
    pub account_storage_cost: U128,
}

/// One pooling window of a night.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowView {
    pub window: u8,
    pub wood: U128,
    /// The pile below this window's wood: the wood of all earlier windows.
    pub start_pile: U128,
    /// The window's weight; for the open night, as if the night ended now.
    pub weight: U128,
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
    /// The night the clock says is burning. Actions for `act` and `throw_wood` name this night.
    pub clock_night: u32,
    /// The pooling window wood landing now falls in, and when it ends.
    pub window_now: u8,
    pub window_end_ms: u64,
    pub windows: Vec<WindowView>,
    pub target: U128,
    pub pile: U128,
    pub throwers: u32,
    /// The pile has reached the target: the night will be lit, new wood counts with `late_lit_bp`.
    pub reached: bool,
    /// The first account to throw wood on the open night.
    pub firestarter: Option<AccountId>,
    /// The throw that crossed the target.
    pub last_log: Option<LastLog>,
    pub streak: u32,
    pub records: Records,
    pub hearth: U128,
    pub supply: U128,
    /// What settled nights still owe throwers who have not collected, and on how many nights.
    pub owed: U128,
    pub owed_nights: u32,
    pub kindling_left_tonight: u32,
    pub accounts_sponsored: u32,
    pub max_accounts: u32,
    pub last: Option<LastNight>,
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
    pub throwers: u32,
    pub minted: U128,
    pub hearth_cut: U128,
    pub burned: U128,
    pub hearth_burned: U128,
    /// None while the night is open.
    pub target_next: Option<U128>,
    pub streak: u32,
    pub supply: Option<U128>,
    pub firestarter: Option<AccountId>,
    pub last_log: Option<LastLog>,
    pub windows: Vec<WindowView>,
    /// What the night still owes throwers who have not collected (settled nights only).
    pub owed: Option<U128>,
    pub uncollected: Option<u32>,
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
pub struct HolderWood {
    pub window: u8,
    pub wood: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HolderView {
    pub account: AccountId,
    pub registered: bool,
    /// `ft_balance_of`: credited plus pending.
    pub balance: U128,
    /// Credited, free EMBER.
    pub credited: U128,
    /// What a settled night owes the account and it has not collected yet.
    pub pending: U128,
    /// The night of the account's wood (open or settled and uncollected).
    pub wood_night: Option<u32>,
    pub wood: U128,
    pub wood_by_window: Vec<HolderWood>,
    /// The weight of that wood: final once the night is settled, as if it ended now before.
    pub weight: U128,
    pub nonce: u64,
    pub sponsored: bool,
    pub held: bool,
    pub kindled: bool,
    pub may_take_kindling: bool,
}

/// What wood thrown now would weigh if its window closed with it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EstimateView {
    pub night: u32,
    pub window: u8,
    pub amount: U128,
    pub weight: U128,
    /// The weight per unit of wood, in bp (10000 = 1.0).
    pub factor_bp: u32,
}

/// Where all the EMBER is. `balanced` and `ledger` must always be true.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditView {
    pub supply: U128,
    /// Sum of credited balances, tracked on every change.
    pub balances: U128,
    pub pile: U128,
    /// The pile recomputed from the open night's windows.
    pub pile_recomputed: U128,
    pub hearth: U128,
    /// What settled nights still owe their throwers, rounding dust included.
    pub owed: U128,
    /// supply == balances + pile + hearth + owed, and the pile equals its recomputation.
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
        ConfigView {
            version: env!("CARGO_PKG_VERSION").to_string(),
            config: self.cfg.clone(),
            founders: self.founders.get().clone().unwrap_or_default(),
            genesis_ms: self.genesis_ms,
            genesis_supply: U128(self.genesis_supply),
            supply_cap: U128(SUPPLY_CAP),
            account_storage_bytes: self.account_bytes,
            account_storage_cost: U128(self.storage_cost().as_yoctonear()),
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
        let window_now = self.window_at(now.saturating_sub(self.night_start(clock)));
        let window_ms = self.cfg.night_ms as u128 * (window_now as u128 + 1) / self.cfg.pool_windows as u128;
        StateView {
            night: self.night,
            night_start_ms: self.night_start(self.night),
            night_end_ms: self.night_end(self.night),
            now_ms: now,
            due: clock > self.night,
            nights_due: clock - self.night,
            clock_night: clock,
            window_now,
            window_end_ms: self.night_start(clock) + window_ms as u64,
            windows: self.open_windows(),
            target: U128(self.target),
            pile: U128(self.pile),
            throwers: self.throwers,
            reached: self.pile >= self.target,
            firestarter: self.firestarter.clone(),
            last_log: self.last_log.clone(),
            streak: self.streak,
            records: self.records.clone(),
            hearth: U128(self.hearth),
            supply: U128(self.supply),
            owed: U128(self.owed),
            owed_nights: self.owed_nights,
            kindling_left_tonight: kindling_left,
            accounts_sponsored: self.sponsored,
            max_accounts: self.cfg.max_accounts,
            last: self.last.clone(),
        }
    }

    pub fn records(&self) -> Records {
        self.records.clone()
    }

    /// The open night so far, or one of the last `log_keep` settled nights. Per-thrower detail is
    /// in the `throw` events and in `holder`.
    pub fn night(&self, n: u32) -> Option<NightView> {
        if n == self.night {
            return Some(NightView {
                night: n,
                outcome: Outcome::Open,
                start_ms: self.night_start(n),
                end_ms: self.night_end(n),
                target: U128(self.target),
                pile: U128(self.pile),
                throwers: self.throwers,
                minted: U128(0),
                hearth_cut: U128(0),
                burned: U128(0),
                hearth_burned: U128(0),
                target_next: None,
                streak: self.streak,
                supply: None,
                firestarter: self.firestarter.clone(),
                last_log: self.last_log.clone(),
                windows: self.open_windows(),
                owed: None,
                uncollected: None,
            });
        }
        if n == 0 || n > self.night {
            return None;
        }
        let log = self.logs.get(&(n % self.cfg.log_keep)).filter(|l| l.night == n)?;
        let owed = self.owed_by_night.get(&n);
        Some(NightView {
            night: n,
            outcome: log.outcome,
            start_ms: self.night_start(n),
            end_ms: self.night_end(n),
            target: U128(log.target),
            pile: U128(log.pile),
            throwers: log.throwers,
            minted: U128(log.minted),
            hearth_cut: U128(log.hearth_cut),
            burned: U128(log.burned),
            hearth_burned: U128(log.hearth_burned),
            target_next: Some(U128(log.target_next)),
            streak: log.streak,
            supply: Some(U128(log.supply)),
            firestarter: log.firestarter.clone(),
            last_log: log.last_log.clone(),
            windows: windows_view(&log.windows),
            owed: Some(U128(owed.map_or(0, |o| o.remaining))),
            uncollected: Some(owed.map_or(0, |o| o.left)),
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
        let mut rows = Vec::new();
        let mut n = from;
        while n <= last && (rows.len() as u32) < limit {
            let Some(r) = self.history_row(n) else { break };
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
        let credited = h.map_or(0, |h| h.balance);
        let pending = h.map_or(0, |h| self.pending_credit(h));
        let p = h.and_then(|h| h.pending.clone());
        let weight = p.as_ref().map_or(0, |p| self.weight_of(p));
        HolderView {
            registered: h.is_some(),
            balance: U128(credited + pending),
            credited: U128(credited),
            pending: U128(pending),
            wood_night: p.as_ref().map(|p| p.night),
            wood: U128(p.as_ref().map_or(0, |p| p.total())),
            wood_by_window: p
                .as_ref()
                .map(|p| p.wood.iter().map(|&(window, wood)| HolderWood { window, wood: U128(wood) }).collect())
                .unwrap_or_default(),
            weight: U128(weight),
            nonce: h.map_or(0, |h| h.nonce),
            sponsored: flags & SPONSORED != 0,
            held: flags & HELD != 0,
            kindled: flags & KINDLED != 0,
            may_take_kindling: flags & HELD == 0 && account_id != env::current_account_id(),
            account: account_id,
        }
    }

    /// What `amount` thrown now would weigh if its window closed with it; more wood in the same
    /// window later shares the window's slice and lowers it.
    pub fn estimate(&self, amount: U128) -> EstimateView {
        let now = env::block_timestamp_ms();
        let clock = self.clock_night(now);
        let window = self.window_at(now.saturating_sub(self.night_start(clock)));
        let mut windows = if clock == self.night { self.windows.clone() } else { vec![0; self.windows.len()] };
        let target = if clock == self.night { self.target } else { self.target.max(self.cfg.target_min.0) };
        windows[window as usize] += amount.0;
        let ws = window_weights(&windows, target, self.cfg.early_max_bp, self.cfg.late_lit_bp);
        let (x, w) = ws[window as usize];
        let weight = if x == 0 { 0 } else { mul_div(w, amount.0, x) };
        let factor = if amount.0 == 0 { 0 } else { mul_div(weight, 1, amount.0) };
        EstimateView {
            night: clock,
            window,
            amount,
            weight: U128(weight),
            factor_bp: factor.min(u32::MAX as u128) as u32,
        }
    }

    /// The last throws, oldest first.
    pub fn recent_throws(&self) -> Vec<RecentThrow> {
        self.recent.get().clone().unwrap_or_default()
    }

    /// Checks that no EMBER appeared or vanished: anyone can call it at any time.
    pub fn audit(&self) -> AuditView {
        let recomputed: u128 = self.windows.iter().sum();
        let sum = self.balances + self.pile + self.hearth + self.owed;
        let (minted, burned) = (self.records.total_minted.0, self.records.total_burned.0);
        AuditView {
            supply: U128(self.supply),
            balances: U128(self.balances),
            pile: U128(self.pile),
            pile_recomputed: U128(recomputed),
            hearth: U128(self.hearth),
            owed: U128(self.owed),
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

fn windows_view(ws: &[(u128, u128)]) -> Vec<WindowView> {
    let mut start = 0;
    ws.iter()
        .enumerate()
        .map(|(i, &(wood, weight))| {
            let v = WindowView { window: i as u8, wood: U128(wood), start_pile: U128(start), weight: U128(weight) };
            start += wood;
            v
        })
        .collect()
}

impl Bonfire {
    fn open_windows(&self) -> Vec<WindowView> {
        windows_view(&window_weights(&self.windows, self.target, self.cfg.early_max_bp, self.cfg.late_lit_bp))
    }

    /// The weight of a holder's wood: from the night's record once settled, from the open night's
    /// windows as if it ended now before that.
    fn weight_of(&self, p: &Pending) -> u128 {
        let ws = if p.night == self.night {
            window_weights(&self.windows, self.target, self.cfg.early_max_bp, self.cfg.late_lit_bp)
        } else {
            match self.owed_by_night.get(&p.night) {
                Some(o) if o.outcome == Outcome::Lit => o.windows.clone(),
                _ => return 0,
            }
        };
        p.wood.iter().map(|&(w, a)| ws.get(w as usize).map_or(0, |&(x, ws)| mul_div(ws, a, x))).sum()
    }

    fn history_row(&self, n: u32) -> Option<HistoryRow> {
        let buckets = self.cfg.history_keep / HISTORY_BUCKET;
        let slot = (n - 1) / HISTORY_BUCKET % buckets;
        let bucket = self.history.get(&slot)?;
        bucket.get(((n - 1) % HISTORY_BUCKET) as usize).filter(|r| r.night == n).cloned()
    }

    /// Outcomes of the last `count` settled nights, oldest first.
    pub(crate) fn recent_outcomes(&self, count: u32) -> Vec<Outcome> {
        let last = self.night - 1;
        let from = last.saturating_sub(count - 1).max(1);
        (from..=last).filter_map(|n| self.history_row(n).map(|r| r.outcome)).collect()
    }

    /// The oldest night `history` still has.
    pub(crate) fn oldest_history_night(&self) -> u32 {
        let last = self.night - 1;
        let buckets = self.cfg.history_keep / HISTORY_BUCKET;
        let newest = (last.max(1) - 1) / HISTORY_BUCKET;
        newest.saturating_sub(buckets - 1) * HISTORY_BUCKET + 1
    }
}
