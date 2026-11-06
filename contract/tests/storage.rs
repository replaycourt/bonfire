//! Storage the contract pays for, measured, against the byte counts README.md documents. The mock
//! VM counts storage per call, so each growth is measured inside the one call that causes it.
mod common;

use bonfire::Bonfire;
use common::*;
use near_sdk::env;

/// README: the largest account record (64-character id, wood in all 4 windows).
const ACCOUNT_MAX: u64 = 211;
/// README: an account record without wood.
const ACCOUNT_BARE: u64 = 135;
/// README: a night log (at most), the record a night with wood keeps until its last thrower
/// collects (at most), one history row, one new history bucket with its first row.
const NIGHT_LOG_MAX: u64 = 472;
const NIGHT_LOG_COLD: u64 = 192;
const OWED_MAX: u64 = 246;
const HISTORY_ROW: u64 = 69;
const HISTORY_NEW_BUCKET: u64 = 118;

/// Bytes `f` adds to storage, flushed inside the same call.
fn growth(g: &mut Game, who: &str, f: impl FnOnce(&mut Bonfire)) -> i64 {
    g.call(&acc(who), 0, |c| {
        // Unit tests never drop the contract, so earlier calls may still have cached writes.
        c.flush();
        let before = env::storage_usage() as i64;
        f(c);
        c.flush();
        env::storage_usage() as i64 - before
    })
}

#[test]
fn an_account_record_never_outgrows_what_registration_charges() {
    let mut g = Game::new();
    assert_eq!(g.view(|c| c.config()).account_storage_bytes, ACCOUNT_MAX);
    let mut c = cfg();
    c.pool_windows = 24;
    let mut g24 = Game::with(c, founders());
    assert_eq!(g24.view(|c| c.config()).account_storage_bytes, ACCOUNT_MAX + 20 * 17);

    let mut k = Key::new(1);
    k.nonce = 1;
    let (hex, text) = (k.hex.clone(), r#"{"claim_kindling":{"night":1}}"#.to_string());
    let sig = k.sign(CONTRACT, 1, &text);
    let bare = growth(&mut g, "relayer.testnet", |c| {
        c.act(hex, 1, text, sig);
    });
    assert_eq!(bare as u64, ACCOUNT_BARE, "a sponsored implicit account");
    // Wood in all four windows fills the record to its maximum, and no further.
    let mut total = bare;
    for w in 0..4u64 {
        g.at(1, w * 250 + 1);
        k.nonce += 1;
        let text = r#"{"throw":{"amount":"50","night":1}}"#.to_string();
        let sig = k.sign(CONTRACT, k.nonce, &text);
        let (hex, nonce) = (k.hex.clone(), k.nonce);
        total += growth(&mut g, "relayer.testnet", |c| {
            assert!(c.act(hex, nonce, text, sig).ok);
        });
    }
    assert!(total as u64 <= ACCOUNT_MAX + 1_900, "the record plus the first write of the recent-throws ring");
}

#[test]
fn cold_nights_cost_a_night_log_slot_and_a_history_row() {
    let mut g = Game::new();
    g.at(2, 0);
    let first = growth(&mut g, "anyone.testnet", |c| {
        c.settle();
    });
    assert_eq!(first as u64, NIGHT_LOG_COLD + HISTORY_NEW_BUCKET);
    g.at(3, 0);
    let second = growth(&mut g, "anyone.testnet", |c| {
        c.settle();
    });
    assert_eq!(second as u64, NIGHT_LOG_COLD + HISTORY_ROW);
}

#[test]
fn a_night_with_wood_keeps_one_record_until_its_last_thrower_collects() {
    let mut g = Game::new();
    let mut all: Vec<_> = (0..6).map(founder).collect();
    for i in 0..10 {
        let a = acc(&format!("{i:0>64}"));
        g.register(&a);
        g.transfer(&founder(0), &a, 3_000);
        g.at(1, i * 90);
        g.throw(&a, 2_500);
        all.push(a);
    }
    g.at(2, 0);
    let settled = growth(&mut g, "anyone.testnet", |c| {
        c.settle();
    });
    eprintln!("a lit night of 10 throwers: {settled} bytes");
    assert!(settled as u64 <= NIGHT_LOG_MAX + OWED_MAX + HISTORY_NEW_BUCKET);
    // The record goes with the last collection; the night log stays for log_keep nights.
    let mut freed = 0;
    for a in all.clone() {
        freed += growth(&mut g, "anyone.testnet", |c| {
            c.collect(a);
        });
    }
    eprintln!("ten collections: {freed} bytes");
    assert!(freed < 0, "collecting frees the night's record and shrinks the accounts' records");
}
