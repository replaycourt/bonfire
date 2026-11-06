//! The hearth's kindling: once per account that never held EMBER, capped per night, paid from a
//! finite hearth, with the contract paying the newcomer's storage up to `max_accounts`.
mod common;

use common::*;
use near_sdk::json_types::U128;

#[test]
fn a_new_browser_key_gets_kindling_and_a_registration_paid_by_the_contract() {
    let mut g = Game::new();
    let mut k = Key::new(1);
    assert!(!g.holder(&k.account).registered);
    let out = g.act_kindle(&mut k);
    assert!(out.ok, "{:?}", out.error);
    assert_eq!(g.balance(&k.account), 500);
    let h = g.holder(&k.account);
    assert!(h.registered && h.sponsored && h.held && h.kindled && !h.may_take_kindling);
    assert_eq!(h.nonce, 1);
    let s = g.state();
    assert_eq!(s.hearth.0, 399_500);
    assert_eq!(s.kindling_left_tonight, 19);
    assert_eq!(s.accounts_sponsored, 7);
    assert_eq!(s.records.kindling_claims, 1);
    let t = g.last_events("nep141");
    assert_eq!(t[0]["event"], "ft_transfer");
    assert_eq!(t[0]["data"][0]["old_owner_id"], CONTRACT);
    assert_eq!(t[0]["data"][0]["new_owner_id"], k.account.as_str());
    assert_eq!(t[0]["data"][0]["memo"], "kindling");
    let b = g.last_events("bonfire");
    assert_eq!(b[0]["event"], "kindling");
    assert_eq!(b[0]["data"][0]["left_tonight"], 19);
    g.assert_events_match();
}

#[test]
fn kindling_is_paid_once_per_account() {
    let mut g = Game::new();
    let mut k = g.kindled_key(1);
    let out = g.act_kindle(&mut k);
    assert!(!out.ok);
    assert!(out.error.unwrap().contains("never held"));
    g.next_night();
    assert!(!g.act_kindle(&mut k).ok, "not on a later night either");
    // Spending it all does not make the account new again.
    let to = founder(0);
    assert!(g.act_transfer(&mut k, &to, 500).ok);
    assert!(!g.act_kindle(&mut k).ok);
}

#[test]
fn an_account_that_ever_held_ember_gets_no_kindling() {
    let mut g = Game::new();
    assert!(g.view(|c| c.holder(founder(0))).held);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| g.kindle(&founder(0))));
    assert!(r.is_err());
    // A wallet that registered itself and was then sent EMBER has held it.
    let w = acc("wallet.testnet");
    g.register(&w);
    assert!(g.holder(&w).may_take_kindling);
    g.transfer(&founder(0), &w, 1);
    assert!(!g.holder(&w).may_take_kindling);
}

#[test]
fn a_self_registered_wallet_takes_kindling_without_using_a_sponsored_seat() {
    let mut g = Game::new();
    let w = acc("wallet.testnet");
    g.register(&w);
    let out = g.kindle(&w);
    assert_eq!(out.amount, U128(500));
    let h = g.holder(&w);
    assert!(h.kindled && !h.sponsored);
    assert_eq!(g.state().accounts_sponsored, 6);
}

#[test]
fn an_unregistered_wallet_is_registered_by_the_contract_on_claiming() {
    let mut g = Game::new();
    let w = acc("newcomer.testnet");
    g.kindle(&w);
    let h = g.holder(&w);
    assert!(h.registered && h.sponsored && h.kindled);
    assert_eq!(g.balance(&w), 500);
}

#[test]
fn kindling_is_capped_per_night_first_come_first_served() {
    let mut g = Game::new();
    for i in 0..20 {
        g.kindled_key(i);
    }
    assert_eq!(g.state().kindling_left_tonight, 0);
    let mut late = Key::new(99);
    let out = g.act_kindle(&mut late);
    assert!(!out.ok);
    assert!(out.error.unwrap().contains("all handed out"));
    assert!(!g.holder(&late.account).registered, "a refused stranger leaves no trace");
    g.next_night();
    assert_eq!(g.state().kindling_left_tonight, 20);
    assert!(g.act_kindle(&mut late).ok);
}

#[test]
fn kindling_stops_when_the_hearth_runs_dry() {
    let mut c = cfg();
    c.hearth_genesis = U128(1_200);
    c.target_start = U128(5_000);
    let mut g = Game::with(c, founders());
    g.kindled_key(1);
    g.kindled_key(2);
    assert_eq!(g.state().kindling_left_tonight, 0, "200 left is not enough for one more");
    let mut k = Key::new(3);
    let out = g.act_kindle(&mut k);
    assert!(out.error.unwrap().contains("hearth is too low"));
    assert_eq!(g.state().hearth.0, 200);
}

#[test]
fn the_contract_pays_storage_for_at_most_max_accounts() {
    let mut c = cfg();
    c.max_accounts = 8;
    let mut g = Game::with(c, founders());
    g.kindled_key(1);
    g.kindled_key(2);
    let mut k = Key::new(3);
    let out = g.act_kindle(&mut k);
    assert!(out.error.unwrap().contains("pays storage for no more accounts"));
    assert!(!g.holder(&k.account).registered);
    // A self-registered account can still claim.
    let w = acc("wallet.testnet");
    g.register(&w);
    g.kindle(&w);
    assert_eq!(g.state().accounts_sponsored, 8);
}

#[test]
fn kindling_per_night_follows_the_clock_even_before_settling() {
    let mut g = Game::new();
    for i in 0..20 {
        g.kindled_key(i);
    }
    // Night 1 ended but nobody settled it: the clock's night counts, and the claim settles it.
    g.at(2, 0);
    let mut k = Key::new(50);
    let out = g.act_kindle(&mut k);
    assert!(out.ok);
    assert_eq!(out.settled, 1);
}
