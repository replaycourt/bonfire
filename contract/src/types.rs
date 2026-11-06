//! State and message types.

use near_sdk::json_types::U128;
use near_sdk::{AccountId, near};

/// The contract paid this account's storage (a founder or a kindling claimer). It stays registered.
pub const SPONSORED: u8 = 1;
/// The account has held EMBER at some point, so it can no longer take kindling.
pub const HELD: u8 = 2;
/// The account took kindling. It stays registered, so the once-only rule holds.
pub const KINDLED: u8 = 4;

/// One registered account.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Holder {
    /// Free EMBER. Wood on the pile is not in here.
    pub balance: u128,
    /// Wood on the open night's pile. Non-zero exactly when the account is among its throwers.
    pub wood: u128,
    /// Weight of that wood, in base units times basis points.
    pub weight: u128,
    /// Last nonce used through `act`.
    pub nonce: u64,
    pub flags: u8,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// The night is still burning (or has ended and waits for `settle`).
    Open,
    /// The pile reached the target.
    Lit,
    /// The pile fell short.
    Smoke,
    /// Nobody threw wood: smoke with nothing to burn from the pile.
    Empty,
}

/// Records and running totals.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Records {
    pub longest_streak: u32,
    /// Largest target a lit night reached.
    pub tallest_fire: U128,
    /// Everything minted since genesis.
    pub total_minted: U128,
    /// Everything burned since genesis: smoke, hearth smoke, and balances given up on unregistering.
    pub total_burned: U128,
    pub nights_lit: u32,
    pub nights_smoke: u32,
    pub nights_empty: u32,
    pub kindling_claims: u32,
}

/// The last settled night, for the icon and the page.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LastNight {
    pub night: u32,
    pub outcome: Outcome,
    pub target: U128,
    pub pile: U128,
}

/// One thrower of a settled night.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThrowerLog {
    pub account: AccountId,
    pub wood: U128,
    pub weight: U128,
    /// What the thrower got back: wood plus share on a lit night, the unburned part on a smoky one.
    pub paid: U128,
}

/// Everything about one settled night, kept for `log_keep` nights.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NightLog {
    pub night: u32,
    pub outcome: Outcome,
    pub target: U128,
    pub pile: U128,
    /// Lit: minted in all (hearth cut plus the throwers' shares).
    pub minted: U128,
    /// Lit: the hearth's part of the mint.
    pub hearth_cut: U128,
    /// Lit: rounding dust of the throwers' shares, never minted.
    pub unminted: U128,
    /// Smoke or empty: burned in all (pile smoke plus hearth smoke).
    pub burned: U128,
    /// Smoke or empty: the hearth's part of the burn.
    pub hearth_burned: U128,
    /// Smoke: rounding dust of the returns, moved to the hearth.
    pub to_hearth: U128,
    pub target_next: U128,
    /// Streak after this night.
    pub streak: u32,
    /// Total supply after this night.
    pub supply: U128,
    /// In order of first throw.
    pub throwers: Vec<ThrowerLog>,
}

/// One compact row per settled night.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryRow {
    pub night: u32,
    pub outcome: Outcome,
    pub target: u128,
    pub pile: u128,
    /// Minted on a lit night, burned on a smoky or empty one.
    pub moved: u128,
    pub supply: u128,
}

/// One action for `act`. Every action names the night it is meant for (`clock_night` in
/// `state()`), so a signed message cannot be replayed into a later night. Examples:
/// `{"throw":{"amount":"5000","night":12}}`, `{"claim_kindling":{"night":12}}`,
/// `{"transfer":{"receiver_id":"bob.testnet","amount":"10","night":12}}`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Throw { amount: U128, night: u32 },
    ClaimKindling { night: u32 },
    Transfer { receiver_id: AccountId, amount: U128, night: u32 },
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActOutcome {
    /// False if the action was refused. The nonce is spent either way once the account exists.
    pub ok: bool,
    pub error: Option<String>,
    pub nonce: u64,
    /// The open night after the call.
    pub night: u32,
    /// Nights this call settled before the action.
    pub settled: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThrowOutcome {
    pub night: u32,
    pub amount: U128,
    /// Weight this throw added.
    pub weight: U128,
    /// The thrower's wood and weight on tonight's pile after the throw.
    pub wood: U128,
    pub weight_total: U128,
    pub pile: U128,
    pub target: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KindlingOutcome {
    pub night: u32,
    pub amount: U128,
    pub left_tonight: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettleOutcome {
    /// Nights settled by this call; 0 if the open night has not ended yet.
    pub settled: u32,
    /// The open night after the call.
    pub night: u32,
    /// Ended nights still waiting; call again if this is not 0.
    pub nights_due: u32,
    pub ends_ms: u64,
}
