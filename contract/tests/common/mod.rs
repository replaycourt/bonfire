//! Shared harness: the real contract in the SDK's mock VM, a clock, wallet accounts, browser keys
//! with real ed25519 signatures, and a ledger rebuilt from nothing but the emitted events.
#![allow(dead_code)]

use bonfire::config::*;
use bonfire::types::*;
use bonfire::views::*;
use bonfire::{Bonfire, signing_message};
use ed25519_dalek::{Signer, SigningKey};
use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_parameters::RuntimeFeesConfig;
use near_parameters::vm::Config as VmConfig;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{AccountId, Gas, MockedBlockchain, NearToken, testing_env};
use std::collections::BTreeMap;
use std::sync::OnceLock;

pub const CONTRACT: &str = "bonfire.testnet";
pub const NIGHT_MS: u64 = 300_000;
pub const START_MS: u64 = 1_800_000_000_000;
pub const ONE_YOCTO: u128 = 1;

pub fn contract_id() -> AccountId {
    CONTRACT.parse().unwrap()
}

pub fn acc(name: &str) -> AccountId {
    name.parse().unwrap()
}

/// The founding accounts of the default launch.
pub fn founder(i: u32) -> AccountId {
    acc(&format!("founder{i}.testnet"))
}

/// The launch values of sim/params.json in whole EMBER (decimals 0), with small caps for the tests.
pub fn cfg() -> Config {
    Config {
        name: "Bonfire Ember".into(),
        symbol: "EMBER".into(),
        decimals: 0,
        night_ms: NIGHT_MS,
        hearth_genesis: U128(400_000),
        target_start: U128(20_000),
        target_min: U128(5_000),
        grow_bp: 700,
        shrink_bp: 1_000,
        mint_bp: 400,
        hearth_cut_bp: 1_000,
        smoke_bp: 300,
        hearth_burn_bp: 25,
        early_max_bp: 40_000,
        late_lit_bp: 2_500,
        pool_windows: 4,
        target_cap_bp: 2_500,
        min_throw: U128(50),
        kindling: U128(250),
        kindling_per_night: 10,
        max_catchup: 30,
        log_keep: 14,
        max_accounts: 1_000,
        history_keep: 4_096,
    }
}

/// Six founders with 100,000 EMBER each: with the hearth, 1,000,000 at genesis.
pub fn founders() -> Vec<Founder> {
    (0..6).map(|i| Founder { account_id: founder(i), amount: U128(100_000) }).collect()
}

/// A browser player: a local ed25519 key and the implicit account it implies.
pub struct Key {
    pub sk: SigningKey,
    pub hex: String,
    pub account: AccountId,
    pub nonce: u64,
}

impl Key {
    pub fn new(i: u32) -> Self {
        let mut seed = [0u8; 32];
        seed[..4].copy_from_slice(&i.to_le_bytes());
        seed[31] = 11;
        let sk = SigningKey::from_bytes(&seed);
        let hex: String = sk.verifying_key().to_bytes().iter().map(|b| format!("{b:02x}")).collect();
        let account = hex.parse().unwrap();
        Self { sk, hex, account, nonce: 0 }
    }

    pub fn sign(&self, contract: &str, nonce: u64, action: &str) -> String {
        let msg = signing_message(contract, nonce, action);
        self.sk.sign(msg.as_bytes()).to_bytes().iter().map(|b| format!("{b:02x}")).collect()
    }
}

/// The SDK parses its whole runtime configuration on every default `testing_env!`; one parsed copy
/// serves every call.
fn vm_config() -> VmConfig {
    static CONFIG: OnceLock<VmConfig> = OnceLock::new();
    CONFIG.get_or_init(near_sdk::test_vm_config).clone()
}

pub fn context(now_ms: u64, who: &AccountId, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .predecessor_account_id(who.clone())
        .signer_account_id(who.clone())
        .block_timestamp(now_ms * 1_000_000)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(50))
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(b.build(), vm_config(), RuntimeFeesConfig::test());
}

/// Throws away everything in the mock VM, including what a previous game left in its storage.
pub fn fresh_chain() {
    near_sdk::env::set_blockchain_interface(MockedBlockchain::new(
        VMContextBuilder::new().build(),
        vm_config(),
        RuntimeFeesConfig::test(),
        Vec::new(),
        Default::default(),
        Default::default(),
        None,
    ));
}

pub struct Game {
    pub c: Bonfire,
    pub now_ms: u64,
    /// Every log line of every call so far.
    pub logs: Vec<String>,
    /// Log lines of the last call.
    pub last_logs: Vec<String>,
}

impl Game {
    pub fn new() -> Self {
        Self::with(cfg(), founders())
    }

    pub fn with(config: Config, founders: Vec<Founder>) -> Self {
        fresh_chain();
        context(START_MS, &contract_id(), 0);
        let c = Bonfire::new(config, founders);
        let mut g = Self { c, now_ms: START_MS, logs: Vec::new(), last_logs: Vec::new() };
        g.gather_logs();
        g
    }

    fn gather_logs(&mut self) {
        self.last_logs = near_sdk::test_utils::get_logs();
        self.logs.extend(self.last_logs.iter().cloned());
    }

    /// One call by `who` with `deposit` yoctoNEAR; its logs are collected.
    pub fn call<R>(&mut self, who: &AccountId, deposit: u128, f: impl FnOnce(&mut Bonfire) -> R) -> R {
        context(self.now_ms, who, deposit);
        let r = f(&mut self.c);
        self.gather_logs();
        r
    }

    pub fn view<R>(&mut self, f: impl FnOnce(&Bonfire) -> R) -> R {
        context(self.now_ms, &acc("viewer.testnet"), 0);
        f(&self.c)
    }

    // ---- clock ---------------------------------------------------------------------------------

    pub fn tick(&mut self, ms: u64) {
        self.now_ms += ms;
    }

    pub fn night_start(n: u32) -> u64 {
        START_MS + (n as u64 - 1) * NIGHT_MS
    }

    /// Moves the clock to `permille` thousandths into night `n`.
    pub fn at(&mut self, n: u32, permille: u64) {
        let t = Self::night_start(n) + NIGHT_MS * permille / 1_000;
        assert!(t >= self.now_ms, "the clock only moves forward");
        self.now_ms = t;
    }

    /// Moves to the start of the next clock night and settles.
    pub fn next_night(&mut self) -> SettleOutcome {
        let clock = self.state().clock_night;
        self.at(clock + 1, 0);
        self.settle()
    }

    // ---- calls ---------------------------------------------------------------------------------

    pub fn settle(&mut self) -> SettleOutcome {
        self.call(&acc("anyone.testnet"), 0, |c| c.settle())
    }

    /// A wallet throw for the clock's night.
    pub fn throw(&mut self, who: &AccountId, amount: u128) -> ThrowOutcome {
        let n = self.clock();
        self.call(who, ONE_YOCTO, |c| c.throw_wood(U128(amount), n))
    }

    /// Anyone collects for `who`; returns the amount.
    pub fn collect(&mut self, who: &AccountId) -> u128 {
        let who = who.clone();
        self.call(&acc("collector.testnet"), 0, |c| c.collect(who)).amount.0
    }

    pub fn collect_all(&mut self, accounts: &[AccountId]) {
        for a in accounts {
            self.collect(a);
        }
    }

    pub fn kindle(&mut self, who: &AccountId) -> KindlingOutcome {
        self.call(who, 0, |c| c.claim_kindling())
    }

    pub fn transfer(&mut self, from: &AccountId, to: &AccountId, amount: u128) {
        self.call(from, ONE_YOCTO, |c| c.ft_transfer(to.clone(), U128(amount), None))
    }

    pub fn register(&mut self, who: &AccountId) {
        let cost =
            self.view(near_contract_standards::storage_management::StorageManagement::storage_balance_bounds).min;
        self.call(who, cost.as_yoctonear(), |c| {
            near_contract_standards::storage_management::StorageManagement::storage_deposit(c, None, None)
        });
    }

    /// Signs with the key's next nonce and sends it through `act`, relayed by a gas account.
    pub fn act(&mut self, key: &mut Key, action: &str) -> ActOutcome {
        key.nonce += 1;
        let sig = key.sign(CONTRACT, key.nonce, action);
        let (hex, nonce) = (key.hex.clone(), key.nonce);
        let action = action.to_string();
        self.call(&acc("relayer.testnet"), 0, |c| c.act(hex, nonce, action, sig))
    }

    pub fn clock(&mut self) -> u32 {
        self.state().clock_night
    }

    pub fn act_throw(&mut self, key: &mut Key, amount: u128) -> ActOutcome {
        let n = self.clock();
        self.act(key, &format!(r#"{{"throw":{{"amount":"{amount}","night":{n}}}}}"#))
    }

    pub fn act_kindle(&mut self, key: &mut Key) -> ActOutcome {
        let n = self.clock();
        self.act(key, &format!(r#"{{"claim_kindling":{{"night":{n}}}}}"#))
    }

    pub fn act_collect(&mut self, key: &mut Key) -> ActOutcome {
        let n = self.clock();
        self.act(key, &format!(r#"{{"collect":{{"night":{n}}}}}"#))
    }

    pub fn act_transfer(&mut self, key: &mut Key, to: &AccountId, amount: u128) -> ActOutcome {
        let n = self.clock();
        self.act(key, &format!(r#"{{"transfer":{{"receiver_id":"{to}","amount":"{amount}","night":{n}}}}}"#))
    }

    /// A browser key with kindling in its account.
    pub fn kindled_key(&mut self, i: u32) -> Key {
        let mut k = Key::new(i);
        let out = self.act_kindle(&mut k);
        assert!(out.ok, "kindling refused: {:?}", out.error);
        k
    }

    // ---- views ---------------------------------------------------------------------------------

    pub fn state(&mut self) -> StateView {
        self.view(|c| c.state())
    }

    pub fn balance(&mut self, who: &AccountId) -> u128 {
        let who = who.clone();
        self.view(|c| c.ft_balance_of(who).0)
    }

    pub fn supply(&mut self) -> u128 {
        self.view(|c| c.ft_total_supply().0)
    }

    pub fn holder(&mut self, who: &AccountId) -> HolderView {
        let who = who.clone();
        self.view(|c| c.holder(who))
    }

    pub fn night_view(&mut self, n: u32) -> Option<NightView> {
        self.view(|c| c.night(n))
    }

    pub fn audit(&mut self) -> AuditView {
        self.view(|c| c.audit())
    }

    /// supply == credited balances + pile + hearth + owed, with the credited balances summed over
    /// `accounts` (which must be every account that ever held EMBER), every audit flag holding,
    /// and the uncollected credit of those accounts adding up to what is owed, short only of
    /// rounding dust.
    pub fn assert_conserved(&mut self, accounts: &[AccountId]) {
        let a = self.audit();
        assert!(a.balanced, "audit unbalanced: {a:?}");
        assert!(a.ledger, "supply != genesis + minted - burned: {a:?}");
        let (mut credited, mut pending) = (0, 0);
        for x in accounts {
            let h = self.holder(x);
            assert_eq!(h.balance.0, h.credited.0 + h.pending.0);
            assert_eq!(self.balance(x), h.balance.0, "ft_balance_of counts the pending credit");
            credited += h.credited.0;
            pending += h.pending.0;
        }
        assert_eq!(credited, a.balances.0, "tracked balances differ from the sum over accounts");
        assert_eq!(credited + a.pile.0 + a.hearth.0 + a.owed.0, a.supply.0, "EMBER appeared or vanished");
        assert!(pending <= a.owed.0, "more pending than owed");
        let nights = self.state().owed_nights as u128;
        assert!(a.owed.0 - pending <= nights * accounts.len() as u128, "owed beyond rounding dust: {a:?}");
        assert_eq!(self.balance(&contract_id()), a.pile.0 + a.hearth.0);
    }

    /// Balances rebuilt from the NEP-141 events alone.
    pub fn replayed(&self) -> BTreeMap<String, i128> {
        let mut m: BTreeMap<String, i128> = BTreeMap::new();
        for e in self.events("nep141") {
            let kind = e["event"].as_str().unwrap().to_string();
            for d in e["data"].as_array().unwrap() {
                let amount: i128 = d["amount"].as_str().unwrap().parse().unwrap();
                assert!(amount > 0, "zero-amount event entry: {d}");
                match kind.as_str() {
                    "ft_mint" => *m.entry(d["owner_id"].as_str().unwrap().into()).or_default() += amount,
                    "ft_burn" => *m.entry(d["owner_id"].as_str().unwrap().into()).or_default() -= amount,
                    "ft_transfer" => {
                        *m.entry(d["old_owner_id"].as_str().unwrap().into()).or_default() -= amount;
                        *m.entry(d["new_owner_id"].as_str().unwrap().into()).or_default() += amount;
                    }
                    other => panic!("unknown nep141 event {other}"),
                }
            }
        }
        m
    }

    /// The events rebuild every credited balance; the contract's replayed balance is the pile, the
    /// hearth and what settled nights still owe; once everyone has collected, the replay equals
    /// `ft_balance_of` for every account.
    pub fn assert_events_match(&mut self) {
        let replay = self.replayed();
        let total: i128 = replay.values().sum();
        assert_eq!(total as u128, self.supply(), "events do not add up to the supply");
        let a = self.audit();
        for (who, v) in replay {
            assert!(v >= 0, "{who} went negative in the event replay");
            let expected =
                if who == CONTRACT { a.pile.0 + a.hearth.0 + a.owed.0 } else { self.holder(&acc(&who)).credited.0 };
            assert_eq!(v as u128, expected, "event replay of {who} differs from its credited balance");
        }
    }

    /// Parsed `EVENT_JSON` lines of one standard, oldest first.
    pub fn events(&self, standard: &str) -> Vec<Value> {
        parse_events(&self.logs, standard)
    }

    pub fn last_events(&self, standard: &str) -> Vec<Value> {
        parse_events(&self.last_logs, standard)
    }
}

pub fn parse_events(logs: &[String], standard: &str) -> Vec<Value> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<Value>(j).expect("event is JSON"))
        .filter(|v| v["standard"] == standard)
        .collect()
}

/// A tiny deterministic generator for the randomized tests.
pub struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}
