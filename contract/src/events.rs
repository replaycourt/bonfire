//! NEP-297 events: the standard NEP-141 `ft_mint`, `ft_burn` and `ft_transfer`, and `bonfire`
//! events `throw`, `lit`, `smoked`, `cold` and `kindling`.
//!
//! A call collects its events and logs them at the end, one log line per event kind with every
//! entry of that kind in its `data` array (the NEP-141 entries are serialized by the structs of
//! near-contract-standards, so the lines are byte for byte what its `emit_many` writes). Collecting
//! first lets the contract count the bytes: NEAR fails a receipt whose logs exceed 16 KiB, so
//! settling stops before the next night could cross `SETTLE_LOG_BUDGET`.
//!
//! The contract account holds the pile, the hearth and what settled nights owe their throwers, and
//! the events say so: a throw is a transfer to the contract, a lit night mints to the contract,
//! smoke burns from it, and a collection is a transfer from it. Replaying the events gives every
//! credited balance exactly.

use crate::config::SUPPLY_CAP;
use crate::types::LastLog;
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
    Smoked,
    Cold,
    Kindling,
    Throw,
}

const KINDS: [(&str, &str); 8] = [
    ("nep141", "ft_mint"),
    ("nep141", "ft_burn"),
    ("nep141", "ft_transfer"),
    ("bonfire", "lit"),
    ("bonfire", "smoked"),
    ("bonfire", "cold"),
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
    entries: [Vec<String>; 8],
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
    pub window: u8,
    pub account: &'a AccountId,
    pub amount: U128,
    /// The pile after the throw.
    pub pile: U128,
    pub target: U128,
    /// This throw was the night's first.
    pub firestarter: bool,
    /// This throw crossed the target.
    pub last_log: bool,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct LitEvent<'a> {
    pub night: u32,
    pub target: U128,
    pub pile: U128,
    pub throwers: u32,
    pub minted: U128,
    pub hearth_cut: U128,
    /// The throwers' part of the mint, shared by weight when they collect.
    pub shared: U128,
    pub weight: U128,
    pub target_next: U128,
    pub streak: u32,
    pub supply: U128,
    pub firestarter: Option<&'a AccountId>,
    pub last_log: Option<&'a LastLog>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct SmokedEvent<'a> {
    pub night: u32,
    pub target: U128,
    pub pile: U128,
    /// How much wood the fire lacked.
    pub short: U128,
    pub throwers: u32,
    pub burned: U128,
    /// The wood that comes back, pro rata, when the throwers collect.
    pub back: U128,
    pub hearth_burned: U128,
    pub target_next: U128,
    pub supply: U128,
    pub firestarter: Option<&'a AccountId>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct ColdEvent {
    pub night: u32,
    pub target: U128,
    pub target_next: U128,
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

/// Bytes of the worst settled night with wood: its mint or burns, its summary with 64-character
/// firestarter and last log, every amount at the supply cap, and every line's frame. It does not
/// depend on the number of throwers: they collect later, each in their own call.
pub(crate) fn night_worst(contract: &AccountId) -> usize {
    let n = u32::MAX;
    let m = U128(SUPPLY_CAP);
    let who = longest_account();
    let log = LastLog { account: who.clone(), amount: m };
    let mut lit = Logs::new();
    lit.mint(contract, SUPPLY_CAP, Some(&memo(n, "lit")));
    let e = LitEvent {
        night: n,
        target: m,
        pile: m,
        throwers: n,
        minted: m,
        hearth_cut: m,
        shared: m,
        weight: U128(u128::MAX),
        target_next: m,
        streak: n,
        supply: m,
        firestarter: Some(&who),
        last_log: Some(&log),
    };
    lit.bonfire(Kind::Lit, &e);
    let mut smoke = Logs::new();
    smoke.burn(contract, SUPPLY_CAP, Some(&memo(n, "smoke")));
    smoke.burn(contract, SUPPLY_CAP, Some(&memo(n, "hearth smoke")));
    let e = SmokedEvent {
        night: n,
        target: m,
        pile: m,
        short: m,
        throwers: n,
        burned: m,
        back: m,
        hearth_burned: m,
        target_next: m,
        supply: m,
        firestarter: Some(&who),
    };
    smoke.bonfire(Kind::Smoked, &e);
    lit.bytes().max(smoke.bytes())
}

/// Upper bound on the bytes of a cold night settled after the current state, up to night `last`:
/// while cold nights are settled the target only falls, so the current target bounds them all.
pub(crate) fn cold_night_bound(last: u32, target: u128) -> usize {
    let mut l = Logs::new();
    l.bonfire(Kind::Cold, &ColdEvent { night: last, target: U128(target), target_next: U128(target) });
    l.bytes()
}
