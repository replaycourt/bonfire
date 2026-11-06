//! The launch parameters. They are init arguments, stored once and readable by anyone through
//! `config()`. No method changes them: to change a rule, somebody has to deploy a different
//! contract, and the contract account has no keys to deploy with.
//!
//! Percentages are basis points (bp): 10_000 bp = 100 % = a factor of 1.0. Amounts are base units
//! of EMBER (one EMBER = 10^decimals base units), passed as decimal strings. The field names are
//! those of `sim/params.json`.

use near_sdk::json_types::U128;
use near_sdk::{AccountId, env, near, require};

/// Basis points in one whole.
pub const BP: u128 = 10_000;
/// The total supply never exceeds 2^112 base units (about 5.2e33). Every weight factor is at most
/// `MAX_EARLY_BP`, so a weight (amount times factor in bp), the integral of the pile-position
/// factor and the sum of a night's weights always fit in a u128. A lit night mints only up to this
/// cap, and the target never grows beyond it.
pub const SUPPLY_CAP: u128 = 1 << 112;
/// Highest allowed `early_max_bp` (a factor of 6.0).
pub const MAX_EARLY_BP: u32 = 60_000;
/// Most pooling windows per night.
pub const MAX_POOL_WINDOWS: u32 = 24;
/// NEAR keeps at most this many bytes of logs per receipt; a call that logs more fails whole.
pub const RUNTIME_LOG_LIMIT: usize = 16_384;
/// Log bytes a call may spend on settling nights. The rest is kept for the call's own events
/// (a collect, a throw, a kindling, a transfer), so settling inside another call never pushes it
/// over the limit.
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
/// Throws `recent_throws` keeps.
pub const RECENT_THROWS: usize = 16;
/// Nights the icon draws along its bottom edge.
pub const ICON_NIGHTS: u32 = 7;

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
    /// The target never falls below this, whatever the cap says.
    pub target_min: U128,
    /// After a lit night the target grows to `target * (10000 + grow_bp) / 10000`.
    pub grow_bp: u32,
    /// After a smoky or cold night the target shrinks to `target * (10000 - shrink_bp) / 10000`.
    pub shrink_bp: u32,
    /// A lit night mints this share of its target. It also caps a smoky night's hearth burn.
    pub mint_bp: u32,
    /// Share of a lit night's mint that goes to the hearth; the rest goes to the throwers by weight.
    pub hearth_cut_bp: u32,
    /// Share of a smoky night's pile that burns; the rest goes back to the throwers pro rata.
    pub smoke_bp: u32,
    /// Share of the hearth that burns on a smoky night, at most one night's mint. Cold nights
    /// (no wood at all) burn nothing.
    pub hearth_burn_bp: u32,
    /// Weight factor of wood on an empty pile; it falls linearly to 10000 at the target.
    pub early_max_bp: u32,
    /// Weight factor of wood above the target.
    pub late_lit_bp: u32,
    /// The night is cut into this many equal windows. All wood landing in one window shares, pro
    /// rata, the weight of the slice of the pile that window's wood covers.
    pub pool_windows: u32,
    /// The target never exceeds this share of the free supply (supply minus hearth minus pile);
    /// 0 means no cap. `target_min` wins when the two conflict.
    pub target_cap_bp: u32,
    /// Smallest throw.
    pub min_throw: U128,
    /// EMBER an account that never held any gets once from the hearth.
    pub kindling: U128,
    /// Most kindling claims paid per night, first come first served.
    pub kindling_per_night: u32,
    /// Most nights one call settles.
    pub max_catchup: u32,
    /// Nights whose full log `night(n)` keeps.
    pub log_keep: u32,
    /// Most accounts whose storage the contract pays (founders and kindling claimers).
    pub max_accounts: u32,
    /// Nights whose one-row summary `history` keeps; a multiple of `HISTORY_BUCKET`.
    pub history_keep: u32,
}

fn ok_text(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.bytes().all(|b| (0x20..0x7f).contains(&b))
}

impl Config {
    /// Panics with the first rule the parameters break; returns the genesis supply.
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
        require!((BP as u32..=MAX_EARLY_BP).contains(&self.early_max_bp), "early_max_bp: 10000 to 60000");
        require!(self.late_lit_bp as u128 <= BP, "late_lit_bp: at most 10000");
        require!((1..=MAX_POOL_WINDOWS).contains(&self.pool_windows), "pool_windows: 1 to 24");
        require!(self.target_cap_bp as u128 <= BP, "target_cap_bp: at most 10000 (0: no cap)");
        require!(self.min_throw.0 >= 1, "min_throw: at least 1");
        require!(self.kindling.0 >= 1, "kindling: at least 1");
        require!(self.kindling_per_night <= 1_000, "kindling_per_night: at most 1000");
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
