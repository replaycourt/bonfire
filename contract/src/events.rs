//! NEP-297 events: the standard NEP-141 `ft_mint`, `ft_burn` and `ft_transfer`, and `bonfire`
//! events for `throw`, `lit`, `smoke` and `kindling`.
//!
//! A call collects its events and logs them at the end, one log line per event kind with every
//! entry of that kind in its `data` array (the NEP-141 entries are serialized by the structs of
//! near-contract-standards, so the lines are byte for byte what its `emit_many` writes). Collecting
//! first lets the contract count the bytes before logging them: NEAR fails a receipt whose logs
//! exceed 16 KiB, so settling stops before the next night could cross `SETTLE_LOG_BUDGET`.
//!
//! The contract account's NEP-141 balance is the pile plus the hearth, and the events say so:
//! a throw is a transfer to the contract, wood comes back as a transfer from it, a lit night mints
//! to the contract and smoke burns from it. Replaying the events gives every balance exactly.

use crate::config::SUPPLY_CAP;
use near_contract_standards::fungible_token::events::{FtBurn, FtMint, FtTransfer};
use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{AccountId, env, serde_json};

#[derive(Clone, Copy)]
pub(crate) enum Kind {
    Mint,
    Burn,
    Transfer,
    Lit,
    Smoke,
    Kindling,
    Throw,
}

const KINDS: [(&str, &str); 7] = [
    ("nep141", "ft_mint"),
    ("nep141", "ft_burn"),
    ("nep141", "ft_transfer"),
    ("bonfire", "lit"),
    ("bonfire", "smoke"),
    ("bonfire", "kindling"),
    ("bonfire", "throw"),
];

/// Version of both the NEP-141 events and the `bonfire` events.
pub const EVENT_VERSION: &str = "1.0.0";
const TAIL: &str = "]}";

fn head(k: usize) -> String {
    let (standard, event) = KINDS[k];
    format!("EVENT_JSON:{{\"standard\":\"{standard}\",\"version\":\"{EVENT_VERSION}\",\"event\":\"{event}\",\"data\":[")
}

fn json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| env::abort())
}

/// The events of one call, logged by `emit`.
pub(crate) struct Logs {
    entries: [Vec<String>; 7],
    bytes: usize,
}

impl Logs {
    pub fn new() -> Self {
        Self { entries: Default::default(), bytes: 0 }
    }

    /// Bytes the logs will take once emitted.
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    fn push(&mut self, k: Kind, entry: String) {
        let i = k as usize;
        self.bytes += if self.entries[i].is_empty() { head(i).len() + TAIL.len() } else { 1 };
        self.bytes += entry.len();
        self.entries[i].push(entry);
    }

    pub fn mint(&mut self, owner: &AccountId, amount: u128, memo: Option<&str>) {
        if amount > 0 {
            self.push(Kind::Mint, json(&FtMint { owner_id: owner, amount: U128(amount), memo }));
        }
    }

    pub fn burn(&mut self, owner: &AccountId, amount: u128, memo: Option<&str>) {
        if amount > 0 {
            self.push(Kind::Burn, json(&FtBurn { owner_id: owner, amount: U128(amount), memo }));
        }
    }

    pub fn transfer(&mut self, from: &AccountId, to: &AccountId, amount: u128, memo: Option<&str>) {
        if amount > 0 {
            let e = FtTransfer { old_owner_id: from, new_owner_id: to, amount: U128(amount), memo };
            self.push(Kind::Transfer, json(&e));
        }
    }

    pub fn bonfire<T: Serialize>(&mut self, k: Kind, data: &T) {
        self.push(k, json(data));
    }

    pub fn emit(self) {
        for (i, e) in self.entries.iter().enumerate() {
            if !e.is_empty() {
                env::log_str(&format!("{}{}{TAIL}", head(i), e.join(",")));
            }
        }
    }
}

pub(crate) fn memo(night: u32, what: &str) -> String {
    format!("night {night} {what}")
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct ThrowEvent<'a> {
    pub night: u32,
    pub account: &'a AccountId,
    pub amount: U128,
    pub weight: U128,
    /// Early factor at the moment the wood landed.
    pub early_bp: u32,
    /// The part of the amount that landed on a pile already at its target (weighted `late_lit_bp`).
    pub late: U128,
    pub pile: U128,
    pub target: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct LitEvent {
    pub night: u32,
    pub target: U128,
    pub pile: U128,
    pub throwers: u32,
    pub minted: U128,
    pub hearth_cut: U128,
    pub unminted: U128,
    pub target_next: U128,
    pub streak: u32,
    pub supply: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct SmokeEvent {
    pub night: u32,
    pub target: U128,
    pub pile: U128,
    pub throwers: u32,
    pub burned: U128,
    pub returned: U128,
    pub to_hearth: U128,
    pub hearth_burned: U128,
    pub target_next: U128,
    pub supply: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct KindlingEvent<'a> {
    pub night: u32,
    pub account: &'a AccountId,
    pub amount: U128,
    pub hearth: U128,
    pub left_tonight: u32,
}

fn longest_account() -> AccountId {
    "a".repeat(64).parse().unwrap_or_else(|_| env::abort())
}

/// Bytes one more thrower adds to a night's payout: an `ft_transfer` entry from the contract to a
/// 64-character account of an amount at the supply cap (no thrower can get more than the supply).
pub(crate) fn per_thrower_worst(contract: &AccountId) -> usize {
    let to = longest_account();
    let e = FtTransfer { old_owner_id: contract, new_owner_id: &to, amount: U128(SUPPLY_CAP), memo: None };
    1 + json(&e).len()
}

fn lit_worst(n: u32) -> LitEvent {
    let m = U128(SUPPLY_CAP);
    LitEvent {
        night: n,
        target: m,
        pile: m,
        throwers: n,
        minted: m,
        hearth_cut: m,
        unminted: m,
        target_next: m,
        streak: n,
        supply: m,
    }
}

fn smoke_worst(n: u32) -> SmokeEvent {
    let m = U128(SUPPLY_CAP);
    SmokeEvent {
        night: n,
        target: m,
        pile: m,
        throwers: n,
        burned: m,
        returned: m,
        to_hearth: m,
        hearth_burned: m,
        target_next: m,
        supply: m,
    }
}

/// Bytes of a night with throwers, without the per-thrower entries: its mint or burns, its
/// summary event, and the frame of the `ft_transfer` line. Every amount in them is at most the
/// supply, which is at most `SUPPLY_CAP`.
pub(crate) fn night_fixed_worst(contract: &AccountId) -> usize {
    let n = u32::MAX;
    let frame = head(Kind::Transfer as usize).len() + TAIL.len();
    let mut lit = Logs::new();
    lit.mint(contract, SUPPLY_CAP, Some(&memo(n, "lit")));
    lit.bonfire(Kind::Lit, &lit_worst(n));
    let mut smoke = Logs::new();
    smoke.burn(contract, SUPPLY_CAP, Some(&memo(n, "smoke")));
    smoke.burn(contract, SUPPLY_CAP, Some(&memo(n, "hearth smoke")));
    smoke.bonfire(Kind::Smoke, &smoke_worst(n));
    frame + lit.bytes().max(smoke.bytes())
}

/// Upper bound on the bytes of an empty night settled after the current state, up to night
/// `last`: while empty nights are settled the target, the hearth and the supply only fall, so
/// their current values bound every later night's numbers. Both lines are counted with their
/// frames in case they are the first of their kind in the call.
pub(crate) fn empty_night_bound(contract: &AccountId, last: u32, target: u128, hearth: u128, supply: u128) -> usize {
    let mut l = Logs::new();
    l.burn(contract, hearth.max(1), Some(&memo(last, "hearth smoke")));
    let z = U128(0);
    let e = SmokeEvent {
        night: last,
        target: U128(target),
        pile: z,
        throwers: 0,
        burned: z,
        returned: z,
        to_hearth: z,
        hearth_burned: U128(hearth),
        target_next: U128(target),
        supply: U128(supply),
    };
    l.bonfire(Kind::Smoke, &e);
    l.bytes()
}
