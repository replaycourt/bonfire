//! Splitting wood across accounts earns nothing: one account throwing X at time t ends the night
//! with what ten accounts throwing X/10 at the same t end it with, up to one base unit of rounding
//! per account, and the rounding always goes against the split.
mod common;

use common::*;
use near_sdk::AccountId;

struct Night {
    /// What founder 1 throws before the tested wood (permille of the night, amount).
    before: (u64, u128),
    /// When the tested wood lands and how much it is in all.
    at: u64,
    x: u128,
}

/// Plays the night with the wood split over `parts` accounts and returns (what those accounts
/// end with in all, what founders 1 and 2 end with, total weight before settling).
fn play(night: &Night, parts: u32) -> (u128, Vec<u128>, u128) {
    let mut g = Game::new();
    let accounts: Vec<AccountId> = (0..parts).map(|i| acc(&format!("split{i}.testnet"))).collect();
    for a in &accounts {
        g.register(a);
        g.transfer(&founder(5), a, night.x / parts as u128);
    }
    g.at(1, night.before.0);
    g.throw(&founder(1), night.before.1);
    g.at(1, night.at);
    for a in &accounts {
        g.throw(a, night.x / parts as u128);
    }
    g.at(1, 800);
    g.throw(&founder(2), 3_000);
    let weight = g.state().weight.0;
    g.next_night();
    let mine: u128 = accounts.iter().map(|a| g.balance(a)).sum();
    let others = vec![g.balance(&founder(1)), g.balance(&founder(2))];
    let mut all: Vec<AccountId> = (0..6).map(founder).collect();
    all.extend(accounts);
    g.assert_conserved(&all);
    g.assert_events_match();
    (mine, others, weight)
}

fn same_outcome(night: Night) -> u128 {
    let (one, others_one, w_one) = play(&night, 1);
    let (ten, others_ten, w_ten) = play(&night, 10);
    assert_eq!(w_one, w_ten, "splitting does not change the weights");
    assert_eq!(others_one, others_ten, "nor what anybody else gets");
    assert!(ten <= one, "the split gained: {ten} > {one}");
    assert!(one - ten < 10, "the split lost more than rounding: {one} vs {ten}");
    assert!(one >= night.x * 9 / 10, "nothing but rounding and smoke takes wood");
    eprintln!("one account: {one}, ten accounts: {ten}");
    one
}

#[test]
fn split_early_wood_earns_the_same() {
    // 8,000 + 9,000 stays below the target of 20,000; founder 2's 3,000 lights it.
    assert!(same_outcome(Night { before: (100, 8_000), at: 300, x: 9_000 }) > 9_000, "a lit night");
}

#[test]
fn split_wood_that_crosses_the_target_earns_the_same() {
    assert!(same_outcome(Night { before: (100, 6_000), at: 300, x: 18_000 }) > 18_000, "a lit night");
}

#[test]
fn split_late_wood_on_a_lit_pile_earns_the_same() {
    assert!(same_outcome(Night { before: (100, 20_000), at: 300, x: 9_000 }) > 9_000, "a lit night");
}

#[test]
fn split_wood_on_a_smoky_night_loses_the_same() {
    assert!(same_outcome(Night { before: (100, 2_000), at: 300, x: 9_010 }) < 9_010, "a smoky night");
}

#[test]
fn rounding_differences_are_actually_exercised() {
    // An uneven night where floor division really bites: the shares of ten accounts lose a few
    // base units against one, never more than one each.
    let night = Night { before: (137, 6_007), at: 333, x: 17_990 };
    let (one, _, _) = play(&night, 1);
    let (ten, _, _) = play(&night, 10);
    assert!(ten <= one && one - ten < 10);
}
