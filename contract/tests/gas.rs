//! The worst cases for one call. Settling no longer touches the throwers, so its cost does not
//! grow with them: a night of 300 throwers with 64-character accounts settles, with a catch-up of
//! 29 cold nights, in one call. Each thrower then collects in its own call, at most once per night.
//! The mock VM meters host calls (storage, logs, signature checks), not wasm instructions; see
//! README.md for the estimate of the rest.
mod common;

use bonfire::config::*;
use common::*;
use near_sdk::env;

struct Measured {
    gas: u64,
    log_bytes: usize,
    log_lines: usize,
}

/// Runs `f` in one call context, flushing the contract's caches inside the metered window as the
/// real runtime does at the end of a call.
fn metered<R>(g: &mut Game, f: impl FnOnce(&mut bonfire::Bonfire) -> R) -> (R, Measured) {
    context(g.now_ms, &acc("anyone.testnet"), 0);
    g.c.flush();
    let before = env::used_gas().as_gas();
    let r = f(&mut g.c);
    g.c.flush();
    let gas = env::used_gas().as_gas() - before;
    let logs = near_sdk::test_utils::get_logs();
    g.logs.extend(logs.iter().cloned());
    (r, Measured { gas, log_bytes: logs.iter().map(|l| l.len()).sum(), log_lines: logs.len() })
}

fn report(what: &str, m: &Measured) {
    eprintln!("{what}: host gas {:.2} Tgas, logs {} bytes in {} lines", m.gas as f64 / 1e12, m.log_bytes, m.log_lines);
}

fn long_name(i: u32) -> near_sdk::AccountId {
    acc(&format!("{i:0>64}"))
}

/// A night with `n` throwers, every one with a 64-character account, spread over the windows.
fn crowded_night(g: &mut Game, n: u32) -> Vec<near_sdk::AccountId> {
    let mut all: Vec<_> = (0..6).map(founder).collect();
    for i in 0..n {
        let a = long_name(i);
        g.register(&a);
        g.transfer(&founder(i % 6), &a, 300);
        all.push(a);
    }
    for (i, a) in all[6..].to_vec().iter().enumerate() {
        g.at(1, i as u64 * 990 / n as u64);
        g.throw(a, 100 + (i as u128 % 7) * 10);
    }
    all
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
fn a_crowded_night_and_a_catch_up_settle_in_one_call_and_each_thrower_collects_cheaply() {
    let mut g = Game::new();
    let all = crowded_night(&mut g, 300);
    assert_eq!(g.state().throwers, 300);
    assert!(g.state().pile.0 >= 20_000, "a lit night");
    g.at(31, 0);
    let (out, m) = metered(&mut g, |c| c.settle());
    report("settle: a lit night of 300 throwers plus 29 cold nights", &m);
    assert_eq!(out.settled, 30);
    assert!(m.log_bytes <= SETTLE_LOG_BUDGET);
    assert!(m.gas < 30_000_000_000_000, "{} Tgas in host calls", m.gas / 1_000_000_000_000);

    let a = all[6].clone();
    let (amount, m) = metered(&mut g, |c| c.collect(a).amount.0);
    report("collect: one thrower of a lit night", &m);
    assert!(amount > 0);
    assert!(m.gas < 3_000_000_000_000);
    g.collect_all(&all);
    assert_eq!(g.state().owed_nights, 0);
    g.assert_conserved(&all);
    g.assert_events_match();
}

#[test]
fn collecting_wood_from_every_one_of_24_windows_stays_cheap() {
    let mut c = cfg();
    c.pool_windows = 24;
    let mut g = Game::with(c, founders());
    let a = long_name(1);
    g.register(&a);
    g.transfer(&founder(0), &a, 30_000);
    for w in 0..24u64 {
        g.at(1, w * 1_000 / 24 + 1);
        g.throw(&a, 1_000);
    }
    assert_eq!(g.holder(&a).wood_by_window.len(), 24);
    g.next_night();
    let who = a.clone();
    let (amount, m) = metered(&mut g, |c| c.collect(who).amount.0);
    report("collect: wood in all 24 windows", &m);
    assert!(amount > 24_000);
    assert!(m.gas < 3_000_000_000_000);
}

#[test]
fn a_throw_that_first_settles_a_long_backlog_fits_the_log_limit() {
    let mut g = Game::new();
    let mut k = g.kindled_key(1);
    crowded_night(&mut g, 50);
    g.at(1 + 1_000, 0);
    let mut calls = 0;
    loop {
        let out = g.act_throw(&mut k, 100);
        let bytes: usize = g.last_logs.iter().map(|l| l.len()).sum();
        assert!(bytes <= RUNTIME_LOG_LIMIT);
        calls += 1;
        if out.ok {
            break;
        }
        assert!(out.settled > 0, "every refused call makes progress");
    }
    eprintln!("a throw after 1,000 unsettled nights lands on call {calls} (max_catchup 30)");
    assert_eq!(calls, 34);
}

#[test]
fn the_log_budget_cuts_a_long_cold_catch_up_short_of_max_catchup() {
    let mut c = cfg();
    c.max_catchup = 1_000;
    let mut g = Game::with(c, founders());
    g.at(1 + 900, 0);
    let (out, m) = metered(&mut g, |c| c.settle());
    report(&format!("settle: {} cold nights in one call", out.settled), &m);
    assert!(out.settled > 100 && out.settled < 900);
    assert!(m.log_bytes <= SETTLE_LOG_BUDGET);
}

#[test]
fn host_gas_of_single_calls() {
    let mut g = Game::new();
    let mut k = Key::new(1);
    let act = |g: &mut Game, k: &mut Key, text: &str| {
        k.nonce += 1;
        let sig = k.sign(CONTRACT, k.nonce, text);
        let (hex, nonce, text) = (k.hex.clone(), k.nonce, text.to_string());
        metered(g, |c| c.act(hex, nonce, text, sig)).1
    };
    let kindle = act(&mut g, &mut k, r#"{"claim_kindling":{"night":1}}"#);
    let throw = act(&mut g, &mut k, r#"{"throw":{"amount":"100","night":1}}"#);
    report("act: claim kindling (new sponsored account)", &kindle);
    report("act: throw", &throw);
    assert!(kindle.gas < 5_000_000_000_000 && throw.gas < 5_000_000_000_000);
}
