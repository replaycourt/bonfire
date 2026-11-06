//! Splitting wood across accounts earns nothing: one account throwing X in a window ends the night
//! with what ten accounts throwing X/10 in the same window end it with, up to one base unit of
//! rounding per account, always against the split; and nobody else's result changes at all,
//! because a night's weights depend only on each window's total wood.
mod common;

use common::*;
use near_sdk::AccountId;

struct Night {
    /// Founder 1's wood before the tested wood: (permille of the night, amount).
    before: (u64, u128),
    /// Where in the night the tested wood lands (its window: permille / 250) and how much.
    at: u64,
    x: u128,
}

/// Plays the night with the wood split over `parts` accounts, each throwing at a slightly
/// different moment of the same window. Returns (what those accounts end with, their weight,
/// what founders 1 and 2 end with).
fn play(night: &Night, parts: u32) -> (u128, u128, Vec<u128>) {
    let mut g = Game::new();
    let accounts: Vec<AccountId> = (0..parts).map(|i| acc(&format!("split{i}.testnet"))).collect();
    for a in &accounts {
        g.register(a);
        g.transfer(&founder(5), a, night.x / parts as u128);
    }
    g.at(1, night.before.0);
    g.throw(&founder(1), night.before.1);
    for (i, a) in accounts.iter().enumerate() {
        g.at(1, night.at + i as u64);
        g.throw(a, night.x / parts as u128);
    }
    g.at(1, 900);
    g.throw(&founder(2), 3_000);
    g.next_night();
    let weight: u128 = accounts.iter().map(|a| g.holder(a).weight.0).sum();
    let mine: u128 = accounts.iter().map(|a| g.balance(a)).sum();
    let others = vec![g.balance(&founder(1)), g.balance(&founder(2))];
    let mut all: Vec<AccountId> = (0..6).map(founder).collect();
    all.extend(accounts);
    g.collect_all(&all);
    g.assert_conserved(&all);
    g.assert_events_match();
    (mine, weight, others)
}

fn same_outcome(night: Night) -> u128 {
    let (one, w_one, others_one) = play(&night, 1);
    let (ten, w_ten, others_ten) = play(&night, 10);
    assert!(w_ten <= w_one && w_one - w_ten < 10, "weights: one {w_one}, ten {w_ten}");
    assert_eq!(others_one, others_ten, "splitting changes nothing for anybody else");
    assert!(ten <= one, "the split gained: {ten} > {one}");
    assert!(one - ten < 10, "the split lost more than rounding: {one} vs {ten}");
    eprintln!("one account: {one}, ten accounts: {ten}");
    one
}

#[test]
fn split_early_wood_earns_the_same() {
    // Founder 1 and the tested wood share window 0; founder 2 lights the fire in window 3.
    assert!(same_outcome(Night { before: (10, 8_000), at: 100, x: 9_000 }) > 9_000, "a lit night");
}

#[test]
fn split_wood_that_crosses_the_target_earns_the_same() {
    assert!(same_outcome(Night { before: (10, 6_000), at: 300, x: 18_000 }) > 18_000, "a lit night");
}

#[test]
fn split_late_wood_on_a_lit_pile_earns_the_same() {
    assert!(same_outcome(Night { before: (10, 20_000), at: 600, x: 9_000 }) > 9_000, "a lit night");
}

#[test]
fn split_wood_on_a_smoky_night_loses_the_same() {
    assert!(same_outcome(Night { before: (10, 2_000), at: 300, x: 9_010 }) < 9_010, "a smoky night");
}

#[test]
fn rounding_differences_are_actually_exercised() {
    let night = Night { before: (37, 6_007), at: 333, x: 17_990 };
    let (one, w_one, _) = play(&night, 1);
    let (ten, w_ten, _) = play(&night, 10);
    assert!(w_one >= w_ten && w_one - w_ten < 10, "ten floors lose at most ten units of weight");
    assert!(ten <= one && one - ten < 10);
}

/// A holder who covers the whole target at the opening bell shares the bottom of the pile with
/// everyone who throws in the same window: pooling contains the solo lighter, it does not remove it.
#[test]
fn a_solo_lighter_shares_its_window_with_the_community() {
    let solo_share = |community_permille: u64| {
        let mut g = Game::new();
        g.at(1, 0);
        g.throw(&founder(0), 20_000);
        g.at(1, community_permille);
        g.throw(&founder(1), 5_000);
        g.throw(&founder(2), 5_000);
        g.next_night();
        g.holder(&founder(0)).pending.0 - 20_000
    };
    // Same window: 20,000 of its 30,000 wood; window 0 weighs 20,000 * 2.5 + 10,000 * 0.25.
    assert_eq!(solo_share(100), 720 * 2 / 3);
    // A window later, the community's wood is late wood and the solo lighter keeps 95%.
    assert_eq!(solo_share(300), 720 * 500 / 525);
}
