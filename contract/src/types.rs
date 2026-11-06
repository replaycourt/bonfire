//! State and message types.

use near_sdk::json_types::U128;
use near_sdk::{AccountId, near};

/// The contract paid this account's storage (a founder or a kindling claimer). It stays registered.
pub const SPONSORED: u8 = 1;
/// The account has held EMBER at some point, so it can no longer take kindling.
pub const HELD: u8 = 2;
/// The account took kindling. It stays registered, so the once-only rule holds.
pub const KINDLED: u8 = 4;

/// Wood a holder threw on one night, by window. A holder can only throw on the night that is
/// burning, so it has at most one of these: it is collected before the holder's next throw.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Pending {
    pub night: u32,
    /// (window, wood), sorted by window.
    pub wood: Vec<(u8, u128)>,
}

impl Pending {
    pub fn total(&self) -> u128 {
        self.wood.iter().map(|w| w.1).sum()
    }

    pub fn add(&mut self, window: u8, amount: u128) {
        match self.wood.binary_search_by_key(&window, |w| w.0) {
            Ok(i) => self.wood[i].1 += amount,
            Err(i) => self.wood.insert(i, (window, amount)),
        }
    }
}

/// One registered account.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Holder {
    /// Credited, free EMBER. Wood on the pile and uncollected credit are not in here.
    pub balance: u128,
    /// Last nonce used through `act`.
    pub nonce: u64,
    pub flags: u8,
    /// Wood on the burning night, or on a settled night not collected yet.
    pub pending: Option<Pending>,
}

/// How a night ended. In JSON: `OPEN`, `LIT`, `SMOKED`, `COLD`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum Outcome {
    /// The night is still burning (or has ended and waits for `settle`).
    Open,
    /// The pile reached the target.
    Lit,
    /// The pile fell short.
    Smoked,
    /// Nobody threw wood.
    Cold,
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
    pub nights_smoked: u32,
    pub nights_cold: u32,
    pub kindling_claims: u32,
}

/// The throw that crossed the target: the wood that made the night safe.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LastLog {
    pub account: AccountId,
    pub amount: U128,
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

/// What a settled night still owes its throwers. It is deleted when the last of them collects.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Owed {
    pub outcome: Outcome,
    pub pile: u128,
    /// Lit: the throwers' share of the mint. Smoked: the wood that comes back.
    pub pool: u128,
    /// Lit: the night's total weight, the sum of the windows' weights.
    pub weight: u128,
    /// Lit: (wood, weight) of every window.
    pub windows: Vec<(u128, u128)>,
    /// Throwers who have not collected yet.
    pub left: u32,
    /// What is still owed; after the last collection, the rounding dust that goes to the hearth.
    pub remaining: u128,
}

/// Everything about one settled night, kept for `log_keep` nights.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NightLog {
    pub night: u32,
    pub outcome: Outcome,
    pub target: u128,
    pub pile: u128,
    pub throwers: u32,
    /// Lit: minted in all (hearth cut plus the throwers' share).
    pub minted: u128,
    pub hearth_cut: u128,
    /// Smoked: burned in all (pile smoke plus hearth smoke), and the hearth's part.
    pub burned: u128,
    pub hearth_burned: u128,
    pub target_next: u128,
    /// Streak after this night.
    pub streak: u32,
    /// Total supply after this night.
    pub supply: u128,
    pub firestarter: Option<AccountId>,
    pub last_log: Option<LastLog>,
    /// (wood, weight) of every window.
    pub windows: Vec<(u128, u128)>,
}

/// One compact row per settled night.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryRow {
    pub night: u32,
    pub outcome: Outcome,
    pub target: u128,
    pub pile: u128,
    /// Minted on a lit night, burned on a smoky one, 0 on a cold one.
    pub moved: u128,
    pub supply: u128,
}

/// One of the most recent throws, for a live feed.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecentThrow {
    pub night: u32,
    pub window: u8,
    pub account: AccountId,
    pub amount: U128,
    /// The pile after the throw.
    pub pile: U128,
    pub at_ms: u64,
}

/// One action for `act`. Every action names the night it is meant for (`clock_night` in
/// `state()`), so a signed message cannot be replayed into a later night. Examples:
/// `{"throw":{"amount":"5000","night":12}}`, `{"claim_kindling":{"night":12}}`,
/// `{"transfer":{"receiver_id":"bob.testnet","amount":"10","night":12}}`, `{"collect":{"night":12}}`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Throw {
        amount: U128,
        night: u32,
    },
    ClaimKindling {
        night: u32,
    },
    Transfer {
        receiver_id: AccountId,
        amount: U128,
        night: u32,
    },
    /// Only collects what earlier nights owe the account (every action does that first).
    Collect {
        night: u32,
    },
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
    /// EMBER credited to the account from an earlier night before the action.
    pub collected: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThrowOutcome {
    pub night: u32,
    pub window: u8,
    pub amount: U128,
    /// The thrower's wood on tonight's pile after the throw.
    pub wood: U128,
    pub pile: U128,
    pub target: U128,
    /// EMBER credited from an earlier night before the throw.
    pub collected: U128,
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

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CollectOutcome {
    pub account: AccountId,
    /// The night the credit came from, if there was one to collect.
    pub night: Option<u32>,
    pub amount: U128,
}
