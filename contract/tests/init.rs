//! Launch: every parameter is checked once at init and then shown, unchanged, by `config()`.
mod common;

use bonfire::Bonfire;
use bonfire::config::*;
use common::*;
use near_sdk::json_types::U128;
use std::panic::{AssertUnwindSafe, catch_unwind};

fn init_error(c: Config, f: Vec<Founder>) -> Option<String> {
    fresh_chain();
    context(START_MS, &contract_id(), 0);
    match catch_unwind(AssertUnwindSafe(|| Bonfire::new(c, f))) {
        Ok(_) => None,
        Err(e) => Some(
            e.downcast_ref::<String>()
                .cloned()
                .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default(),
        ),
    }
}

#[test]
fn the_default_launch_is_valid_and_config_shows_it_unchanged() {
    let mut g = Game::new();
    let v = g.view(|c| c.config());
    assert_eq!(v.config, cfg());
    assert_eq!(v.founders, founders());
    assert_eq!(v.genesis_supply, U128(1_000_000));
    assert_eq!(v.genesis_ms, START_MS);
    assert_eq!(v.supply_cap, U128(SUPPLY_CAP));
    let s = g.state();
    assert_eq!((s.night, s.target.0, s.hearth.0, s.supply.0, s.streak), (1, 20_000, 400_000, 1_000_000, 0));
    assert_eq!(s.accounts_sponsored, 6);
    assert!(g.audit().balanced);
}

#[test]
fn every_bad_parameter_is_refused_at_init() {
    type Case = (&'static str, Box<dyn Fn(&mut Config, &mut Vec<Founder>)>);
    let cases: Vec<Case> = vec![
        ("name:", Box::new(|c, _| c.name = String::new())),
        ("name:", Box::new(|c, _| c.name = "x".repeat(65))),
        ("symbol:", Box::new(|c, _| c.symbol = "EMBER\n".into())),
        ("decimals:", Box::new(|c, _| c.decimals = 25)),
        ("night_ms:", Box::new(|c, _| c.night_ms = 999)),
        ("night_ms:", Box::new(|c, _| c.night_ms = 31 * 86_400_000)),
        (
            "founders: at most 64",
            Box::new(|_, f| {
                *f = (0..65).map(|i| Founder { account_id: acc(&format!("f{i}.testnet")), amount: U128(1) }).collect()
            }),
        ),
        ("founders: every allocation must be positive", Box::new(|_, f| f[0].amount = U128(0))),
        ("founders: the contract itself", Box::new(|_, f| f[0].account_id = contract_id())),
        ("founders: an account is listed twice", Box::new(|_, f| f[1].account_id = founder(0))),
        ("genesis supply: above the supply cap", Box::new(|c, _| c.hearth_genesis = U128(SUPPLY_CAP))),
        ("genesis supply: above the supply cap", Box::new(|c, _| c.hearth_genesis = U128(u128::MAX))),
        (
            "genesis supply: must be positive",
            Box::new(|c, f| {
                f.clear();
                c.hearth_genesis = U128(0);
            }),
        ),
        ("target_min: at least 1", Box::new(|c, _| c.target_min = U128(0))),
        ("target_start: below target_min", Box::new(|c, _| c.target_min = U128(20_001))),
        ("target_start: above the genesis supply", Box::new(|c, _| c.target_start = U128(1_000_001))),
        ("grow_bp:", Box::new(|c, _| c.grow_bp = 10_001)),
        ("shrink_bp:", Box::new(|c, _| c.shrink_bp = 10_000)),
        ("mint_bp:", Box::new(|c, _| c.mint_bp = 10_001)),
        ("hearth_cut_bp:", Box::new(|c, _| c.hearth_cut_bp = 10_001)),
        ("smoke_bp:", Box::new(|c, _| c.smoke_bp = 10_001)),
        ("hearth_burn_bp:", Box::new(|c, _| c.hearth_burn_bp = 10_001)),
        ("early_max_bp:", Box::new(|c, _| c.early_max_bp = 9_999)),
        ("early_max_bp:", Box::new(|c, _| c.early_max_bp = 60_001)),
        ("late_lit_bp:", Box::new(|c, _| c.late_lit_bp = 10_001)),
        ("min_throw:", Box::new(|c, _| c.min_throw = U128(0))),
        ("kindling:", Box::new(|c, _| c.kindling = U128(0))),
        ("kindling_per_night:", Box::new(|c, _| c.kindling_per_night = 1_001)),
        ("pool_windows:", Box::new(|c, _| c.pool_windows = 0)),
        ("pool_windows:", Box::new(|c, _| c.pool_windows = 25)),
        ("target_cap_bp:", Box::new(|c, _| c.target_cap_bp = 10_001)),
        ("max_accounts: below the number of founders", Box::new(|c, _| c.max_accounts = 5)),
        ("max_accounts: at most", Box::new(|c, _| c.max_accounts = 1_000_001)),
        ("max_catchup:", Box::new(|c, _| c.max_catchup = 0)),
        ("max_catchup:", Box::new(|c, _| c.max_catchup = 1_001)),
        ("log_keep:", Box::new(|c, _| c.log_keep = 0)),
        ("log_keep:", Box::new(|c, _| c.log_keep = 367)),
        ("history_keep:", Box::new(|c, _| c.history_keep = 0)),
        ("history_keep:", Box::new(|c, _| c.history_keep = 100)),
        ("history_keep:", Box::new(|c, _| c.history_keep = (1 << 20) + 32)),
    ];
    for (expected, mutate) in cases {
        let (mut c, mut f) = (cfg(), founders());
        mutate(&mut c, &mut f);
        let err = init_error(c, f).unwrap_or_else(|| panic!("init accepted a launch that breaks \"{expected}\""));
        assert!(err.contains(expected), "expected \"{expected}\", got \"{err}\"");
    }
}

#[test]
fn the_edges_of_every_range_are_accepted() {
    let mut c = cfg();
    c.grow_bp = 10_000;
    c.shrink_bp = 9_999;
    c.mint_bp = 10_000;
    c.hearth_cut_bp = 10_000;
    c.smoke_bp = 10_000;
    c.hearth_burn_bp = 10_000;
    c.early_max_bp = 60_000;
    c.pool_windows = 24;
    c.target_cap_bp = 10_000;
    c.late_lit_bp = 0;
    c.kindling_per_night = 0;
    c.max_catchup = 1_000;
    c.log_keep = 366;
    c.history_keep = 32;
    c.target_min = c.target_start;
    assert_eq!(init_error(c, founders()), None);
    let mut c = cfg();
    c.pool_windows = 1;
    c.target_cap_bp = 0;
    assert_eq!(init_error(c, Vec::new()), None, "a launch without founders gives everything to the hearth");
}

#[test]
fn a_night_s_events_fit_one_receipt_whatever_the_contract_is_called() {
    // Throwers collect in their own calls, so a night's events do not grow with them.
    for name in ["fire.near", CONTRACT, &"b".repeat(64)] {
        let worst = bonfire::night_log_worst(&acc(name));
        eprintln!("worst settled night for {name}: {worst} bytes of logs");
        assert!(worst < SETTLE_LOG_BUDGET / 10);
    }
}
