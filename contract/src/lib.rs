//! Bonfire: a memecoin whose holders build a bonfire together every night. See ../DESIGN.md for
//! the rules and README.md for the API.
//!
//! The contract has no owner, no admin method and no upgrade method. Every rule is a launch
//! parameter (`config.rs`), stored once by `new` and never changed.

pub mod config;
pub mod math;
pub mod types;
pub mod views;

mod events;
mod icon;
mod ritual;
mod token;

use config::*;
use events::Logs;
use near_sdk::json_types::U128;
use near_sdk::store::{LazyOption, LookupMap};
use near_sdk::{AccountId, BorshStorageKey, PanicOnDefault, env, near, require, serde_json};
use types::*;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Holders,
    Owed,
    Logs,
    History,
    Founders,
    Recent,
}

#[near(
    contract_state,
    contract_metadata(
        standard(standard = "nep141", version = "1.0.0"),
        standard(standard = "nep145", version = "1.0.0"),
        standard(standard = "nep148", version = "1.0.0")
    )
)]
#[derive(PanicOnDefault)]
pub struct Bonfire {
    pub(crate) cfg: Config,
    pub(crate) genesis_ms: u64,
    pub(crate) genesis_supply: u128,
    /// Storage one account record can take (64-character id, wood in every window), measured at init.
    pub(crate) account_bytes: u64,
    /// The open night: every night before it is settled.
    pub(crate) night: u32,
    pub(crate) target: u128,
    pub(crate) pile: u128,
    /// Wood of the open night by window.
    pub(crate) windows: Vec<u128>,
    /// Distinct throwers of the open night.
    pub(crate) throwers: u32,
    pub(crate) firestarter: Option<AccountId>,
    pub(crate) last_log: Option<LastLog>,
    pub(crate) hearth: u128,
    pub(crate) supply: u128,
    /// Sum of all credited balances.
    pub(crate) balances: u128,
    /// What settled nights still owe their throwers, rounding dust included.
    pub(crate) owed: u128,
    /// Settled nights with throwers who have not collected yet.
    pub(crate) owed_nights: u32,
    pub(crate) streak: u32,
    pub(crate) records: Records,
    pub(crate) last: Option<LastNight>,
    /// Clock night the kindling count belongs to.
    pub(crate) kindling_night: u32,
    pub(crate) kindling_claims: u32,
    /// Accounts whose storage the contract paid.
    pub(crate) sponsored: u32,
    pub(crate) holders: LookupMap<AccountId, Holder>,
    /// By night, for settled nights with throwers who have not collected yet.
    pub(crate) owed_by_night: LookupMap<u32, Owed>,
    /// Night logs by `night % log_keep`.
    pub(crate) logs: LookupMap<u32, NightLog>,
    /// History buckets by `(night - 1) / HISTORY_BUCKET % (history_keep / HISTORY_BUCKET)`.
    pub(crate) history: LookupMap<u32, Vec<HistoryRow>>,
    pub(crate) founders: LazyOption<Vec<Founder>>,
    pub(crate) recent: LazyOption<Vec<RecentThrow>>,
}

/// Log bytes of the worst settled night with wood (its mint or burns and its summary event). It
/// does not grow with the number of throwers, and `new` checks it fits `SETTLE_LOG_BUDGET`.
pub fn night_log_worst(contract: &AccountId) -> usize {
    events::night_worst(contract)
}

/// The exact text a browser key signs for `act`.
pub fn signing_message(contract: &str, nonce: u64, action: &str) -> String {
    format!("bonfire:v1:{contract}:{nonce}:{action}")
}

#[near]
impl Bonfire {
    /// Lights the first night. Can only run once, as part of the deployment: it stores every
    /// parameter, mints the genesis supply to the founders and the hearth, and starts night 1.
    #[init]
    #[private]
    pub fn new(config: Config, founders: Vec<Founder>) -> Self {
        let me = env::current_account_id();
        let genesis = config.validate(&founders, &me);
        require!(events::night_worst(&me) <= SETTLE_LOG_BUDGET, "a night's events would not fit in one receipt's logs");
        let mut c = Self {
            genesis_ms: env::block_timestamp_ms(),
            genesis_supply: genesis,
            account_bytes: 0,
            night: 1,
            target: config.target_start.0,
            pile: 0,
            windows: vec![0; config.pool_windows as usize],
            throwers: 0,
            firestarter: None,
            last_log: None,
            hearth: config.hearth_genesis.0,
            supply: genesis,
            balances: 0,
            owed: 0,
            owed_nights: 0,
            streak: 0,
            records: Records::default(),
            last: None,
            kindling_night: 1,
            kindling_claims: 0,
            sponsored: 0,
            holders: LookupMap::new(Key::Holders),
            owed_by_night: LookupMap::new(Key::Owed),
            logs: LookupMap::new(Key::Logs),
            history: LookupMap::new(Key::History),
            founders: LazyOption::new(Key::Founders, None),
            recent: LazyOption::new(Key::Recent, Some(Vec::new())),
            cfg: config,
        };
        c.account_bytes = c.measure_account_bytes();
        let mut logs = Logs::new();
        for f in founders.iter() {
            let h = Holder { balance: f.amount.0, flags: SPONSORED | HELD, ..Default::default() };
            c.holders.insert(f.account_id.clone(), h);
            c.balances += f.amount.0;
            c.sponsored += 1;
            logs.mint(&f.account_id, f.amount.0, Some("genesis"));
        }
        logs.mint(&me, c.hearth, Some("genesis hearth"));
        c.founders.set(Some(founders));
        logs.emit();
        c
    }

    /// Plays one signed action for the implicit account of `player_pubkey`, whoever relays it.
    ///
    /// `player_pubkey` and `signature` are lowercase hex (32 and 64 bytes). `action` is one JSON
    /// action (see `Action`), and the signature covers the UTF-8 bytes of
    /// `bonfire:v1:<contract id>:<nonce>:<action>`. `nonce` must be above the account's last one.
    ///
    /// A bad signature, a used nonce or malformed JSON fails the call. A refused action does not:
    /// overdue nights are still settled, what earlier nights owe the account is still collected,
    /// the nonce is spent if the account exists, and `error` says why. A key whose account does
    /// not exist and whose action is refused leaves no trace.
    pub fn act(&mut self, player_pubkey: String, nonce: u64, action: String, signature: String) -> ActOutcome {
        require!(action.len() <= MAX_ACTION_BYTES, "action too long");
        require!(nonce <= MAX_NONCE, "nonce too large");
        let key: [u8; 32] = parse_hex(&player_pubkey).unwrap_or_else(|| env::panic_str("bad public key"));
        let sig: [u8; 64] = parse_hex(&signature).unwrap_or_else(|| env::panic_str("bad signature encoding"));
        let msg = signing_message(env::current_account_id().as_str(), nonce, &action);
        require!(env::ed25519_verify(&sig, msg.as_bytes(), &key), "bad signature");
        let actor: AccountId = player_pubkey.parse().unwrap_or_else(|_| env::panic_str("bad public key"));
        let seen = self.holders.get(&actor).map_or(0, |h| h.nonce);
        require!(nonce > seen, "nonce already used");
        let parsed: Action = serde_json::from_str(&action).unwrap_or_else(|_| env::panic_str("malformed action"));

        let mut logs = Logs::new();
        let settled = self.catch_up(&mut logs);
        let collected = self.credit(&actor, &mut logs).1;
        let result = self.run_action(&actor, parsed, &mut logs);
        if let Some(h) = self.holders.get_mut(&actor) {
            h.nonce = nonce;
        }
        logs.emit();
        ActOutcome {
            ok: result.is_ok(),
            error: result.err(),
            nonce,
            night: self.night,
            settled,
            collected: U128(collected),
        }
    }
}

impl Bonfire {
    fn run_action(&mut self, actor: &AccountId, action: Action, logs: &mut Logs) -> Result<(), String> {
        let clock = self.clock_night(env::block_timestamp_ms());
        let named = match &action {
            Action::Throw { night, .. }
            | Action::ClaimKindling { night }
            | Action::Transfer { night, .. }
            | Action::Collect { night } => *night,
        };
        if named != clock {
            return Err(format!("the action is for night {named}, but this is night {clock}"));
        }
        match action {
            Action::Throw { amount, .. } => self.do_throw(actor, amount.0, logs).map(|_| ()),
            Action::ClaimKindling { .. } => self.do_claim_kindling(actor, logs).map(|_| ()),
            Action::Transfer { receiver_id, amount, .. } => self.do_transfer(actor, &receiver_id, amount.0, None, logs),
            Action::Collect { .. } => Ok(()),
        }
    }

    /// Writes every cached collection entry now. The contract does this on its own at the end of
    /// each call; tests call it to meter the writes inside the call they measure.
    #[doc(hidden)]
    pub fn flush(&mut self) {
        self.holders.flush();
        self.owed_by_night.flush();
        self.logs.flush();
        self.history.flush();
        self.founders.flush();
        self.recent.flush();
    }

    /// Storage of the largest account record: a 64-character id with wood in every window.
    fn measure_account_bytes(&mut self) -> u64 {
        let probe: AccountId = "a".repeat(64).parse().unwrap_or_else(|_| env::abort());
        let wood = (0..self.cfg.pool_windows).map(|w| (w as u8, u128::MAX)).collect();
        let full = Holder {
            balance: u128::MAX,
            nonce: u64::MAX,
            flags: u8::MAX,
            pending: Some(Pending { night: u32::MAX, wood }),
        };
        let before = env::storage_usage();
        self.holders.insert(probe.clone(), full);
        self.holders.flush();
        let bytes = env::storage_usage() - before;
        self.holders.remove(&probe);
        self.holders.flush();
        bytes
    }
}

pub(crate) fn parse_hex<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != N * 2 {
        return None;
    }
    let digit = |b: u8| match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        _ => None,
    };
    let bytes = s.as_bytes();
    let mut out = [0u8; N];
    for i in 0..N {
        out[i] = digit(bytes[i * 2])? << 4 | digit(bytes[i * 2 + 1])?;
    }
    Some(out)
}
