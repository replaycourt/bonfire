//! Storage the contract pays for, measured, against the byte counts README.md documents. The mock
//! VM counts storage per call, so each growth is measured inside the one call that causes it.
mod common;

use bonfire::Bonfire;
use common::*;
use near_sdk::env;

/// README: one account record (64-character account id).
const ACCOUNT: u64 = 166;
/// README: one seat in tonight's thrower list (64-character account id).
const SEAT: u64 = 113;
/// README: one night log, plus at most this much per thrower in it.
const NIGHT_LOG: u64 = 218;
const NIGHT_LOG_PER_THROWER: u64 = 116;
/// README: one history bucket of 32 nights.
const HISTORY_BUCKET_BYTES: u64 = 2_257;

/// Bytes `f` adds to storage, flushed inside the same call.
fn growth(g: &mut Game, who: &str, f: impl FnOnce(&mut Bonfire)) -> u64 {
    g.call(&acc(who), 0, |c| {
        // Unit tests never drop the contract, so earlier calls may still have cached writes.
        c.flush();
        let before = env::storage_usage();
        f(c);
        c.flush();
        env::storage_usage() - before
    })
}

#[test]
fn an_account_record_is_what_storage_deposit_charges() {
    let mut g = Game::new();
    assert_eq!(g.view(|c| c.config()).account_storage_bytes, ACCOUNT);
    let k = Key::new(1);
    let (hex, text) = (k.hex.clone(), r#"{"claim_kindling":{"night":1}}"#.to_string());
    let sig = k.sign(CONTRACT, 1, &text);
    let bytes = growth(&mut g, "relayer.testnet", |c| {
        c.act(hex, 1, text, sig);
    });
    assert_eq!(bytes, ACCOUNT, "a sponsored implicit account");
}

#[test]
fn a_night_log_and_a_history_bucket_stay_within_the_bounds() {
    let mut g = Game::new();
    g.at(2, 0);
    // The first settled night writes one night log and opens one history bucket.
    let first = growth(&mut g, "anyone.testnet", |c| {
        c.settle();
    });
    eprintln!("an empty night: {first} bytes (night log + new history bucket)");
    assert!(first <= NIGHT_LOG + HISTORY_BUCKET_BYTES);
    // The next one adds a row to the bucket and a log in a new slot.
    g.at(3, 0);
    let second = growth(&mut g, "anyone.testnet", |c| {
        c.settle();
    });
    eprintln!("the second empty night: {second} bytes");
    assert!(second <= NIGHT_LOG + 69);
}

#[test]
fn seats_and_thrower_entries_stay_within_the_bounds() {
    let mut g = Game::new();
    let mut keys: Vec<Key> = (0..10).map(|i| g.kindled_key(i)).collect();
    let mut seats = 0;
    for k in keys.iter_mut() {
        k.nonce += 1;
        let text = r#"{"throw":{"amount":"100","night":1}}"#.to_string();
        let sig = k.sign(CONTRACT, k.nonce, &text);
        let (hex, nonce) = (k.hex.clone(), k.nonce);
        seats += growth(&mut g, "relayer.testnet", |c| {
            assert!(c.act(hex, nonce, text, sig).ok);
        });
    }
    eprintln!("10 seats: {seats} bytes");
    assert!(seats <= 10 * SEAT);
    g.at(2, 0);
    let log = growth(&mut g, "anyone.testnet", |c| {
        c.settle();
    });
    eprintln!("their night: {log} bytes");
    assert!(log <= NIGHT_LOG + 10 * NIGHT_LOG_PER_THROWER + HISTORY_BUCKET_BYTES);
}
