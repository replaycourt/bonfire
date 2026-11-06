//! The worst case for one call: a night with the most throwers the log budget allows, all with
//! 64-character implicit accounts and long amounts, settled together with a catch-up of empty
//! nights. The mock VM meters host calls (storage, logs, signature checks), not wasm instructions;
//! see README.md for the estimate of the rest.
mod common;

use bonfire::config::*;
use common::*;
use near_sdk::env;
use near_sdk::json_types::U128;

struct Measured {
    settled: u32,
    gas: u64,
    log_bytes: usize,
    log_lines: usize,
}

/// Runs `f` in one call context, flushing the contract's caches inside the metered window as the
/// real runtime does at the end of a call.
fn metered(g: &mut Game, f: impl FnOnce(&mut bonfire::Bonfire) -> u32) -> Measured {
    context(g.now_ms, &acc("anyone.testnet"), 0);
    let before = env::used_gas().as_gas();
    let settled = f(&mut g.c);
    g.c.flush();
    let gas = env::used_gas().as_gas() - before;
    let logs = near_sdk::test_utils::get_logs();
    g.logs.extend(logs.iter().cloned());
    Measured { settled, gas, log_bytes: logs.iter().map(|l| l.len()).sum(), log_lines: logs.len() }
}

fn report(what: &str, m: &Measured) {
    eprintln!(
        "{what}: {} nights settled, host gas {:.1} Tgas, logs {} bytes in {} lines",
        m.settled,
        m.gas as f64 / 1e12,
        m.log_bytes,
        m.log_lines
    );
}

/// A launch whose amounts have the most digits the supply cap allows.
fn fat_launch(throwers: u32, target: u128) -> Game {
    let mut c = cfg();
    c.decimals = 24;
    c.hearth_genesis = U128(1 << 110);
    c.target_start = U128(target);
    c.target_min = U128(1 << 90);
    c.kindling = U128(1);
    c.kindling_per_night = 1_000;
    c.max_throwers_per_night = throwers;
    c.max_catchup = 30;
    let f = vec![Founder { account_id: founder(0), amount: U128(1 << 111) }];
    Game::with(c, f)
}

fn full_night(g: &mut Game, throwers: u32, each: u128) -> Vec<Key> {
    let mut keys = Vec::new();
    for i in 0..throwers {
        let mut k = Key::new(10_000 + i);
        assert!(g.act_kindle(&mut k).ok);
        g.transfer(&founder(0), &k.account, each);
        keys.push(k);
    }
    for (i, k) in keys.iter_mut().enumerate() {
        g.at(1, i as u64 * 900 / throwers as u64);
        let out = g.act_throw(k, each);
        assert!(out.ok, "{:?}", out.error);
    }
    keys
}

#[test]
fn the_mock_vm_enforces_the_runtime_log_limit() {
    // Otherwise the log checks below would prove nothing.
    let _g = Game::new();
    context(START_MS, &acc("anyone.testnet"), 0);
    let r = std::panic::catch_unwind(|| env::log_str(&"x".repeat(RUNTIME_LOG_LIMIT + 1)));
    assert!(r.is_err());
}

#[test]
fn a_full_lit_night_and_a_catch_up_fit_one_call() {
    let limit = max_throwers_limit(&contract_id());
    let mut g = fat_launch(limit, 1 << 100);
    let keys = full_night(&mut g, limit, 1 << 104);
    assert_eq!(g.state().throwers, limit);
    let mut all: Vec<_> = keys.iter().map(|k| k.account.clone()).collect();
    all.push(founder(0));

    g.at(1 + 200, 0);
    let m = metered(&mut g, |c| c.settle().settled);
    report(&format!("lit night with {limit} throwers + catch-up"), &m);
    assert!(m.log_bytes <= SETTLE_LOG_BUDGET, "{} log bytes", m.log_bytes);
    assert!(m.log_lines <= 10);
    assert!(m.settled >= 1);
    assert!(m.gas < 100_000_000_000_000, "{} Tgas in host calls", m.gas / 1_000_000_000_000);
    assert_eq!(g.night_view(1).unwrap().throwers.len(), limit as usize);

    // The rest of the backlog: empty nights only, max_catchup per call.
    let m = metered(&mut g, |c| c.settle().settled);
    report("30 empty nights", &m);
    assert_eq!(m.settled, 30);
    assert!(m.log_bytes <= SETTLE_LOG_BUDGET);
    while g.settle().settled > 0 {}
    g.assert_conserved(&all);
    g.assert_events_match();
}

#[test]
fn a_full_smoky_night_fits_one_call() {
    let limit = max_throwers_limit(&contract_id());
    let mut g = fat_launch(limit, (1 << 111) + (1 << 110));
    let keys = full_night(&mut g, limit, 1 << 104);
    g.at(2, 0);
    let m = metered(&mut g, |c| c.settle().settled);
    report(&format!("smoky night with {limit} throwers"), &m);
    assert!(m.log_bytes <= SETTLE_LOG_BUDGET);
    assert!(m.gas < 100_000_000_000_000);
    let mut all: Vec<_> = keys.iter().map(|k| k.account.clone()).collect();
    all.push(founder(0));
    g.assert_conserved(&all);
    g.assert_events_match();
}

#[test]
fn a_throw_that_settles_a_full_night_first_still_fits() {
    let limit = max_throwers_limit(&contract_id());
    let mut g = fat_launch(limit, 1 << 100);
    let mut keys = full_night(&mut g, limit, 1 << 104);
    g.at(1 + 40, 0);
    // The settle inside the throw uses the budget; the throw's own events use the reserve. The
    // full night fills nearly all of the budget, so the backlog takes a few calls; each is refused
    // until the clock's night is open, and the last one throws.
    let mut calls = 0;
    loop {
        let out = g.act_throw(&mut keys[0], 1 << 103);
        let bytes: usize = g.last_logs.iter().map(|l| l.len()).sum();
        eprintln!("throw call {calls}: settled {} nights first, logs {bytes} bytes, ok {}", out.settled, out.ok);
        assert!(bytes <= RUNTIME_LOG_LIMIT);
        calls += 1;
        if out.ok {
            break;
        }
        assert!(out.settled > 0, "every refused call makes progress");
    }
    assert_eq!(calls, 3);
    assert_eq!(g.state().night, 41);
}

#[test]
fn host_gas_of_single_calls() {
    let mut g = Game::new();
    let mut k = Key::new(1);
    context(g.now_ms, &acc("relayer.testnet"), 0);
    let before = env::used_gas().as_gas();
    let text = r#"{"claim_kindling":{"night":1}}"#;
    k.nonce = 1;
    let sig = k.sign(CONTRACT, 1, text);
    g.c.act(k.hex.clone(), 1, text.into(), sig);
    g.c.flush();
    let kindle = env::used_gas().as_gas() - before;
    context(g.now_ms, &acc("relayer.testnet"), 0);
    let before = env::used_gas().as_gas();
    let text = r#"{"throw":{"amount":"100","night":1}}"#;
    let sig = k.sign(CONTRACT, 2, text);
    g.c.act(k.hex.clone(), 2, text.into(), sig);
    g.c.flush();
    let throw = env::used_gas().as_gas() - before;
    eprintln!("host gas: act kindling {:.2} Tgas, act throw {:.2} Tgas", kindle as f64 / 1e12, throw as f64 / 1e12);
    assert!(kindle < 5_000_000_000_000 && throw < 5_000_000_000_000);
}
