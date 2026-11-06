//! The launch parameters. They are init arguments, stored once and readable by anyone through
//! `config()`. No method changes them: to change a rule, somebody has to deploy a different
//! contract, and the contract account has no keys to deploy with.
//!
//! Percentages are basis points (bp): 10_000 bp = 100 % = a factor of 1.0. Amounts are base units
//! of EMBER (one EMBER = 10^decimals base units), passed as decimal strings.

use crate::events;
use near_sdk::json_types::U128;
use near_sdk::{AccountId, env, near, require};

/// Basis points in one whole.
pub const BP: u128 = 10_000;
/// The total supply never exceeds 2^112 base units (about 5.2e33). Every weight factor is at most
/// `MAX_EARLY_BP`, so a weight (amount times factor in bp) and the sum of tonight's weights always
/// fit in a u128. A lit night mints only up to this cap, and the target never grows beyond it.
pub const SUPPLY_CAP: u128 = 1 << 112;
/// Highest allowed `early_max_bp` (a factor of 5.0).
pub const MAX_EARLY_BP: u32 = 50_000;
/// NEAR keeps at most this many bytes of logs per receipt; a call that logs more fails whole.
pub const RUNTIME_LOG_LIMIT: usize = 16_384;
/// Log bytes a call may spend on settling nights. The rest is kept for the call's own events
/// (a throw, a kindling, a transfer), so settling inside another call can never push it over.
pub const SETTLE_LOG_BUDGET: usize = RUNTIME_LOG_LIMIT - 1_024;
/// History rows share storage entries in buckets of this many nights.
pub const HISTORY_BUCKET: u32 = 32;
/// Nonces stop at the largest integer a JavaScript number holds exactly.
pub const MAX_NONCE: u64 = 9_007_199_254_740_991;
/// Longest `action` string `act` accepts.
pub const MAX_ACTION_BYTES: usize = 512;
/// Most founding accounts at genesis (their mint events must fit in the init call's logs).
pub const MAX_FOUNDERS: usize = 64;
/// Most rows one `history` call returns.
pub const MAX_HISTORY_PAGE: u32 = 500;

/// One founding holder and its genesis allocation.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Founder {
    pub account_id: AccountId,
    pub amount: U128,
}

/// Every rule of the ritual, fixed at launch.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    /// Token name and symbol for `ft_metadata`.
    pub name: String,
    pub symbol: String,
    /// Decimals of EMBER; every amount below is in base units.
    pub decimals: u8,
    /// Length of one night in milliseconds. Night 1 starts at the init block.
    pub night_ms: u64,
    /// What the hearth holds at launch. The founders get their allocations on top.
    pub hearth_genesis: U128,
    /// Wood the pile needs on night 1.
    pub target_start: U128,
    /// The target never shrinks below this.
    pub target_min: U128,
    /// After a lit night the target grows by this share (rounded down).
    pub grow_bp: u32,
    /// After a smoky or empty night the target shrinks by this share (rounded down).
    pub shrink_bp: u32,
    /// A lit night mints this share of its target.
    pub mint_bp: u32,
    /// Share of a lit night's mint that goes to the hearth; the rest goes to the throwers by weight.
    pub hearth_cut_bp: u32,
    /// Share of a smoky night's pile that burns; the rest goes back to the throwers pro rata.
    pub smoke_bp: u32,
    /// Share of the hearth that burns on every smoky or empty night.
    pub hearth_burn_bp: u32,
    /// Weight factor of wood landing at the very start of a night; it falls linearly to 1.0 at the end.
    pub early_max_bp: u32,
    /// Weight factor of wood landing on a pile that already reached the target.
    pub late_lit_bp: u32,
    /// Smallest throw. It makes a seat at the fire cost real wood, see `max_throwers_per_night`.
    pub min_throw: U128,
    /// EMBER an account that never held any gets once from the hearth.
    pub kindling: U128,
    /// Most kindling claims paid per night, first come first served.
    pub kindling_per_night: u32,
    /// Most distinct accounts that may throw wood on one night. Every thrower is paid in the call
    /// that settles the night, so this bounds that call's logs and gas; see `max_throwers_limit`.
    pub max_throwers_per_night: u32,
    /// Most accounts whose storage the contract pays (founders and kindling claimers).
    pub max_accounts: u32,
    /// Most nights one call settles.
    pub max_catchup: u32,
    /// Nights whose full log (throwers, weights, payouts) `night(n)` keeps.
    pub log_keep: u32,
    /// Nights whose one-row summary `history` keeps; a multiple of `HISTORY_BUCKET`.
    pub history_keep: u32,
}

fn ok_text(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.bytes().all(|b| (0x20..0x7f).contains(&b))
}

impl Config {
    /// Panics with the first rule the parameters break.
    pub fn validate(&self, founders: &[Founder], contract: &AccountId) -> u128 {
        require!(ok_text(&self.name, 64), "name: 1 to 64 printable ASCII characters");
        require!(ok_text(&self.symbol, 16), "symbol: 1 to 16 printable ASCII characters");
        require!(self.decimals <= 24, "decimals: at most 24");
        require!((1_000..=30 * 86_400_000).contains(&self.night_ms), "night_ms: 1 second to 30 days");
        require!(founders.len() <= MAX_FOUNDERS, "founders: at most 64");
        let mut genesis = self.hearth_genesis.0;
        for (i, f) in founders.iter().enumerate() {
            require!(f.amount.0 > 0, "founders: every allocation must be positive");
            require!(&f.account_id != contract, "founders: the contract itself holds only the hearth");
            require!(
                founders[..i].iter().all(|g| g.account_id != f.account_id),
                "founders: an account is listed twice"
            );
            genesis = genesis
                .checked_add(f.amount.0)
                .unwrap_or_else(|| env::panic_str("genesis supply: above the supply cap"));
        }
        require!(genesis > 0, "genesis supply: must be positive");
        require!(genesis <= SUPPLY_CAP, "genesis supply: above the supply cap");
        require!(self.target_min.0 >= 1, "target_min: at least 1");
        require!(self.target_min.0 <= self.target_start.0, "target_start: below target_min");
        require!(self.target_start.0 <= genesis, "target_start: above the genesis supply");
        require!(self.grow_bp as u128 <= BP, "grow_bp: at most 10000");
        require!((self.shrink_bp as u128) < BP, "shrink_bp: below 10000");
        require!(self.mint_bp as u128 <= BP, "mint_bp: at most 10000");
        require!(self.hearth_cut_bp as u128 <= BP, "hearth_cut_bp: at most 10000");
        require!(self.smoke_bp as u128 <= BP, "smoke_bp: at most 10000");
        require!(self.hearth_burn_bp as u128 <= BP, "hearth_burn_bp: at most 10000");
        require!((BP as u32..=MAX_EARLY_BP).contains(&self.early_max_bp), "early_max_bp: 10000 to 50000");
        require!(self.late_lit_bp as u128 <= BP, "late_lit_bp: at most 10000");
        require!(self.min_throw.0 >= 1, "min_throw: at least 1");
        require!(self.kindling.0 >= 1, "kindling: at least 1");
        require!(self.kindling_per_night <= 1_000, "kindling_per_night: at most 1000");
        require!(self.max_throwers_per_night >= 1, "max_throwers_per_night: at least 1");
        let limit = max_throwers_limit(contract);
        if self.max_throwers_per_night > limit {
            env::panic_str(&format!(
                "max_throwers_per_night: at most {limit} for a contract named {contract}, or the \
                 night's payout events would not fit in one receipt's logs"
            ));
        }
        require!(founders.len() as u64 <= self.max_accounts as u64, "max_accounts: below the number of founders");
        require!(self.max_accounts <= 1_000_000, "max_accounts: at most 1000000");
        require!((1..=1_000).contains(&self.max_catchup), "max_catchup: 1 to 1000");
        require!((1..=366).contains(&self.log_keep), "log_keep: 1 to 366");
        require!(
            (HISTORY_BUCKET..=1 << 20).contains(&self.history_keep) && self.history_keep.is_multiple_of(HISTORY_BUCKET),
            "history_keep: a multiple of 32 from 32 to 1048576"
        );
        genesis
    }
}

/// Most throwers per night a contract with this account id can pay out in one call: the night's
/// summary events plus one `ft_transfer` entry per thrower, each at its longest (a 64-character
/// account and an amount at the supply cap), must fit in `SETTLE_LOG_BUDGET`.
pub fn max_throwers_limit(contract: &AccountId) -> u32 {
    let fixed = events::night_fixed_worst(contract);
    ((SETTLE_LOG_BUDGET.saturating_sub(fixed)) / events::per_thrower_worst(contract)) as u32
}
