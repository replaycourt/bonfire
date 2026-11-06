//! One night at a time: lit, smoked and cold nights, weights by pile position in pooled windows,
//! the target's cap and floor, the hearth burn and its cap, firestarter and last log. Expected
//! numbers are worked out by hand from the launch values (decimals 0, 4 windows of 75 s).
mod common;

use bonfire::types::Outcome;
use common::*;
use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_sdk::json_types::U128;

fn everyone() -> Vec<near_sdk::AccountId> {
    (0..6).map(founder).collect()
}

/// Founder 0: 12,000 in window 0; founder 1: 8,000 in window 1 (reaches the target);
/// founder 2: 4,000 in window 2 (late wood).
fn lit_night(g: &mut Game) {
    g.at(1, 0);
    g.throw(&founder(0), 12_000);
    g.at(1, 300);
    g.throw(&founder(1), 8_000);
    g.at(1, 600);
    g.throw(&founder(2), 4_000);
}

#[test]
fn a_lit_night_owes_wood_back_and_the_mint_by_weight() {
    let mut g = Game::new();
    lit_night(&mut g);
    let s = g.state();
    assert!(s.reached);
    assert_eq!(s.firestarter, Some(founder(0)));
    assert_eq!(s.last_log.as_ref().map(|l| (l.account.clone(), l.amount.0)), Some((founder(1), 8_000)));
    // Window weights: 12,000 on an empty pile: 12,000 * 4.0 - 12,000 * 3.0 * 12,000 / 40,000;
    // 8,000 from 12,000 to 20,000: 8,000 * 4.0 - 8,000 * 3.0 * 32,000 / 40,000; 4,000 late at 0.25.
    let w: Vec<u128> = s.windows.iter().map(|w| w.weight.0).collect();
    assert_eq!(w, vec![372_000_000, 128_000_000, 10_000_000, 0]);
    assert_eq!(s.windows[2].start_pile, U128(20_000));
    g.assert_conserved(&everyone());

    let out = g.next_night();
    assert_eq!(out.settled, 1);
    // mint = 4% of 20,000 = 800; hearth 10% = 80; 720 shared over 372 : 128 : 10.
    let s = g.state();
    assert_eq!((s.hearth.0, s.supply.0, s.target.0, s.streak), (400_080, 1_000_800, 21_400, 1));
    assert_eq!(s.owed.0, 24_000 + 720);
    let h = g.holder(&founder(0));
    assert_eq!((h.credited.0, h.pending.0, h.balance.0), (88_000, 12_525, 100_525));
    assert_eq!(h.weight.0, 372_000_000);
    assert_eq!(g.balance(&founder(1)), 100_180);
    assert_eq!(g.balance(&founder(2)), 100_014);
    let n = g.night_view(1).unwrap();
    assert_eq!(n.outcome, Outcome::Lit);
    assert_eq!((n.minted.0, n.hearth_cut.0, n.throwers, n.uncollected), (800, 80, 3, Some(3)));
    assert_eq!(n.firestarter, Some(founder(0)));
    assert_eq!(n.last_log.unwrap().account, founder(1));
    let lit = g.last_events("bonfire");
    assert_eq!(lit[0]["event"], "lit");
    assert_eq!(lit[0]["data"][0]["firestarter"], "founder0.testnet");
    assert_eq!(lit[0]["data"][0]["last_log"]["account"], "founder1.testnet");
    g.assert_conserved(&everyone());
    g.assert_events_match();

    // Collecting moves the credit; the night's last collection moves the one unit of dust.
    g.collect_all(&everyone());
    let s = g.state();
    assert_eq!((s.hearth.0, s.owed.0, s.owed_nights), (400_081, 0, 0));
    assert_eq!(g.holder(&founder(0)).credited.0, 100_525);
    assert!(g.night_view(1).unwrap().uncollected == Some(0));
    g.assert_conserved(&everyone());
    g.assert_events_match();
}

#[test]
fn a_smoky_night_burns_part_of_the_pile_and_the_hearth_burn_is_capped_by_the_mint() {
    let mut g = Game::new();
    g.throw(&founder(0), 10_000);
    g.throw(&founder(1), 3_333);
    g.next_night();
    // burn = 3% of 13,333 = 399; 12,934 back pro rata: 9,700.7 and 3,233.3, rounded down.
    // The hearth would burn 0.25% of 400,000 = 1,000, but at most one night's mint: 800.
    let s = g.state();
    assert_eq!((s.hearth.0, s.supply.0, s.target.0, s.streak), (399_200, 1_000_000 - 399 - 800, 18_000, 0));
    assert_eq!(g.balance(&founder(0)), 99_700);
    assert_eq!(g.balance(&founder(1)), 99_900);
    let n = g.night_view(1).unwrap();
    assert_eq!((n.outcome, n.burned.0, n.hearth_burned.0), (Outcome::Smoked, 1_199, 800));
    let e = g.last_events("bonfire");
    assert_eq!(e[0]["event"], "smoked");
    assert_eq!(e[0]["data"][0]["short"], "6667");
    g.collect_all(&everyone());
    assert_eq!(g.state().hearth.0, 399_201, "the return's rounding dust goes to the hearth");
    g.assert_conserved(&everyone());
    g.assert_events_match();
}

#[test]
fn a_small_hearth_burns_its_share_below_the_cap() {
    let mut c = cfg();
    c.hearth_genesis = U128(100_000);
    let mut g = Game::with(c, founders());
    g.throw(&founder(0), 1_000);
    g.next_night();
    let n = g.night_view(1).unwrap();
    assert_eq!(n.hearth_burned.0, 250, "0.25% of 100,000, below 800");
}

#[test]
fn a_cold_night_burns_nothing_and_shrinks_the_target() {
    let mut g = Game::new();
    g.next_night();
    let s = g.state();
    assert_eq!((s.hearth.0, s.supply.0, s.target.0, s.streak), (400_000, 1_000_000, 18_000, 0));
    assert_eq!(s.records.nights_cold, 1);
    assert_eq!(g.night_view(1).unwrap().outcome, Outcome::Cold);
    assert!(g.last_events("nep141").is_empty(), "nothing minted or burned");
    let e = g.last_events("bonfire");
    assert_eq!(e[0]["event"], "cold");
}

#[test]
fn the_weight_falls_with_the_pile_and_the_whole_target_earns_the_average() {
    let mut g = Game::new();
    // One unit on an empty pile earns early_max (less the rounding of 3.0 / 40,000).
    assert_eq!(g.view(|c| c.estimate(U128(1))).weight.0, 39_999);
    // The whole target at once earns (4.0 + 1.0) / 2.
    let e = g.view(|c| c.estimate(U128(20_000)));
    assert_eq!((e.weight.0, e.factor_bp, e.window), (20_000 * 25_000, 25_000, 0));
    // Beyond the target, late_lit.
    let e = g.view(|c| c.estimate(U128(40_000)));
    assert_eq!(e.weight.0, 20_000 * 25_000 + 20_000 * 2_500);
}

#[test]
fn the_same_wood_earns_less_in_a_later_window() {
    let mut g = Game::new();
    g.at(1, 10);
    g.throw(&founder(0), 5_000);
    g.at(1, 300);
    g.throw(&founder(1), 5_000);
    g.at(1, 900);
    g.throw(&founder(2), 10_000);
    let w = |g: &mut Game, i| g.holder(&founder(i)).weight.0;
    let (a, b, c) = (w(&mut g, 0), w(&mut g, 1), w(&mut g, 2));
    assert!(a > b && b > c / 2, "{a} {b} {c}");
    g.next_night();
    assert!(g.balance(&founder(0)) > g.balance(&founder(1)));
}

#[test]
fn inside_a_window_the_order_of_throws_does_not_matter() {
    // Founder 0 throws 14,000 and founder 1 throws 6,000, both in window 0, in either order.
    let rewards = |zero_first: bool| {
        let mut g = Game::new();
        let order = if zero_first { [(0, 14_000), (1, 6_000)] } else { [(1, 6_000), (0, 14_000)] };
        for (i, (who, amount)) in order.into_iter().enumerate() {
            g.at(1, 10 + 100 * i as u64);
            g.throw(&founder(who), amount);
        }
        g.next_night();
        (g.holder(&founder(0)).pending.0 - 14_000, g.holder(&founder(1)).pending.0 - 6_000)
    };
    let (a, b) = rewards(true);
    assert_eq!((a, b), rewards(false));
    // Pro rata within the window: 720 * 14 / 20 and 720 * 6 / 20.
    assert_eq!((a, b), (504, 216));
}

#[test]
fn the_target_is_capped_by_the_free_supply() {
    let mut c = cfg();
    c.target_start = U128(15_000);
    let f: Vec<_> = (0..6).map(|i| bonfire::config::Founder { account_id: founder(i), amount: U128(10_000) }).collect();
    let mut g = Game::with(c, f);
    g.throw(&founder(0), 10_000);
    g.throw(&founder(1), 5_000);
    g.next_night();
    // Rule: 15,000 * 1.07 = 16,050. Cap: (460,600 - 400,060) * 25% = 15,135.
    assert_eq!(g.state().target.0, 15_135);
}

#[test]
fn target_min_wins_over_the_cap() {
    let mut c = cfg();
    c.target_min = U128(15_000);
    let f: Vec<_> = (0..4).map(|i| bonfire::config::Founder { account_id: founder(i), amount: U128(10_000) }).collect();
    let mut g = Game::with(c, f);
    g.next_night();
    // Rule 18,000, cap 40,000 * 25% = 10,000, floor 15,000.
    assert_eq!(g.state().target.0, 15_000);
}

#[test]
fn without_a_cap_the_target_follows_the_rule() {
    let mut c = cfg();
    c.target_cap_bp = 0;
    let f: Vec<_> = (0..4).map(|i| bonfire::config::Founder { account_id: founder(i), amount: U128(10_000) }).collect();
    let mut g = Game::with(c, f);
    g.next_night();
    assert_eq!(g.state().target.0, 18_000);
}

#[test]
fn the_target_grows_after_lit_nights_and_never_falls_below_its_floor() {
    let mut g = Game::new();
    let mut targets = vec![];
    for _ in 0..3 {
        let t = g.state().target.0;
        g.throw(&founder(0), t);
        g.next_night();
        targets.push(g.state().target.0);
    }
    assert_eq!(targets, vec![21_400, 22_898, 24_500]);
    assert_eq!(g.state().records.longest_streak, 3);
    assert_eq!(g.state().records.tallest_fire.0, 22_898);
    let mut seen = vec![];
    for _ in 0..20 {
        g.next_night();
        seen.push(g.state().target.0);
    }
    assert_eq!(&seen[..3], &[22_050, 19_845, 17_860], "target * 0.9, rounded down as in the model");
    assert_eq!(*seen.last().unwrap(), 5_000);
    assert_eq!(g.state().records.longest_streak, 3, "the record outlives the streak");
}

#[test]
fn a_holder_may_throw_in_several_windows_and_the_wood_adds_up() {
    let mut g = Game::new();
    g.at(1, 10);
    g.throw(&founder(0), 1_000);
    g.at(1, 20);
    g.throw(&founder(0), 500);
    g.at(1, 800);
    let t = g.throw(&founder(0), 1_000);
    assert_eq!((t.wood.0, t.window), (2_500, 3));
    let h = g.holder(&founder(0));
    assert_eq!(h.wood_by_window.iter().map(|w| (w.window, w.wood.0)).collect::<Vec<_>>(), vec![(0, 1_500), (3, 1_000)]);
    assert_eq!((h.credited.0, h.wood_night), (97_500, Some(1)));
    assert_eq!(g.state().throwers, 1);
}

#[test]
fn there_is_no_cap_on_throwers() {
    let mut g = Game::new();
    let mut all = everyone();
    for i in 0..40 {
        let w = acc(&format!("w{i}.testnet"));
        g.register(&w);
        g.transfer(&founder(5), &w, 600);
        g.throw(&w, 500);
        all.push(w);
    }
    assert_eq!(g.state().throwers, 40);
    g.next_night();
    g.collect_all(&all);
    g.assert_conserved(&all);
    g.assert_events_match();
}

#[test]
fn recent_throws_keep_the_last_sixteen() {
    let mut g = Game::new();
    for i in 0..20 {
        g.at(1, 10 * i);
        g.throw(&founder((i % 6) as u32), 100 + i as u128);
    }
    let r = g.view(|c| c.recent_throws());
    assert_eq!(r.len(), 16);
    assert_eq!(r.last().unwrap().amount.0, 119);
    assert_eq!(r[0].amount.0, 104);
}

#[test]
#[should_panic(expected = "not enough free EMBER")]
fn wood_cannot_be_thrown_twice() {
    let mut g = Game::new();
    g.throw(&founder(0), 60_000);
    g.throw(&founder(0), 60_000);
}

#[test]
#[should_panic(expected = "part of it is wood on tonight's fire")]
fn wood_on_the_pile_cannot_be_transferred() {
    let mut g = Game::new();
    g.throw(&founder(0), 60_000);
    g.transfer(&founder(0), &founder(1), 50_000);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn throwing_from_a_wallet_needs_one_yocto() {
    let mut g = Game::new();
    g.call(&founder(0), 0, |c| c.throw_wood(U128(100), 1));
}

#[test]
#[should_panic(expected = "the throw is for night 1, but this is night 2")]
fn a_throw_for_an_ended_night_fails() {
    let mut g = Game::new();
    g.at(2, 10);
    g.call(&founder(0), ONE_YOCTO, |c| c.throw_wood(U128(100), 1));
}

#[test]
#[should_panic(expected = "the smallest throw is 50 base units")]
fn throws_below_the_minimum_are_refused() {
    let mut g = Game::new();
    g.throw(&founder(0), 49);
}

#[test]
fn ft_transfer_call_to_the_contract_with_msg_throw_and_the_night_throws_the_wood() {
    let mut g = Game::new();
    let used =
        g.call(&founder(0), ONE_YOCTO, |c| c.ft_transfer_call(contract_id(), U128(5_000), None, "throw:1".into()));
    match used {
        near_sdk::PromiseOrValue::Value(v) => assert_eq!(v.0, 5_000),
        _ => panic!("a throw is settled in the same call"),
    }
    assert_eq!(g.holder(&founder(0)).wood.0, 5_000);
    let t = g.last_events("nep141");
    assert_eq!(t[0]["data"][0]["new_owner_id"], CONTRACT);
    assert_eq!(t[0]["data"][0]["memo"], "throw");
    assert_eq!(g.last_events("bonfire")[0]["event"], "throw");
}

#[test]
#[should_panic(expected = "the throw is for night 1, but this is night 2")]
fn ft_transfer_call_throws_carry_the_night_guard() {
    let mut g = Game::new();
    g.at(2, 10);
    let _ = g.call(&founder(0), ONE_YOCTO, |c| c.ft_transfer_call(contract_id(), U128(500), None, "throw:1".into()));
}

#[test]
#[should_panic(expected = "send it with msg")]
fn ft_transfer_call_to_the_contract_without_the_night_fails() {
    let mut g = Game::new();
    let _ = g.call(&founder(0), ONE_YOCTO, |c| c.ft_transfer_call(contract_id(), U128(500), None, "throw".into()));
}

#[test]
fn settle_does_nothing_before_the_night_ends_and_settles_after() {
    let mut g = Game::new();
    g.at(1, 999);
    let out = g.settle();
    assert_eq!((out.settled, out.night, out.nights_due), (0, 1, 0));
    g.at(2, 0);
    assert!(g.state().due);
    let out = g.settle();
    assert_eq!((out.settled, out.night, out.nights_due), (1, 2, 0));
    assert_eq!(out.ends_ms, Game::night_start(3));
    assert_eq!(g.state().last.unwrap().outcome, Outcome::Cold);
}

#[test]
fn a_throw_on_a_new_night_settles_the_old_one_and_collects_first() {
    let mut g = Game::new();
    g.throw(&founder(0), 20_000);
    g.at(2, 100);
    let t = g.throw(&founder(0), 1_000);
    assert_eq!((t.night, t.collected.0), (2, 20_720));
    assert_eq!(g.state().streak, 1);
    assert_eq!(g.holder(&founder(0)).credited.0, 100_720 - 1_000);
    assert_eq!(g.state().pile.0, 1_000);
}
