//! One night at a time: lit, smoke, empty nights, weights, the target's bounds, the hearth's burn,
//! streaks and records. Expected numbers are worked out by hand from the default parameters.
mod common;

use bonfire::types::Outcome;
use common::*;
use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_sdk::json_types::U128;

fn everyone() -> Vec<near_sdk::AccountId> {
    (0..6).map(founder).collect()
}

#[test]
fn a_lit_night_returns_the_wood_and_shares_the_mint_by_weight() {
    let mut g = Game::new();
    g.at(1, 0);
    let a = g.throw(&founder(0), 12_000);
    assert_eq!(a.weight.0, 12_000 * 15_000);
    g.at(1, 500);
    let b = g.throw(&founder(1), 8_000);
    assert_eq!(b.weight.0, 8_000 * 12_500, "half way through the night the early factor is 1.25");
    g.at(1, 750);
    let c = g.throw(&founder(2), 4_000);
    assert_eq!(c.weight.0, 4_000 * 5_000, "the pile had reached the target: late_lit");
    assert_eq!(g.balance(&founder(0)), 88_000);
    assert_eq!(g.balance(&contract_id()), 400_000 + 24_000);
    g.assert_conserved(&everyone());

    let out = g.next_night();
    assert_eq!(out.settled, 1);
    // mint = 5% of 20,000 = 1,000; hearth 20% = 200; 800 shared over weights 180M : 100M : 20M.
    assert_eq!(g.balance(&founder(0)), 100_000 + 480);
    assert_eq!(g.balance(&founder(1)), 100_000 + 266);
    assert_eq!(g.balance(&founder(2)), 100_000 + 53);
    let s = g.state();
    assert_eq!(s.hearth.0, 400_200);
    assert_eq!(s.supply.0, 1_000_999, "one base unit of rounding dust stays unminted");
    assert_eq!(s.target.0, 21_000);
    assert_eq!(s.pile.0, 0);
    assert_eq!(s.streak, 1);
    assert_eq!(s.records.tallest_fire.0, 20_000);
    assert_eq!(s.records.total_minted.0, 999);
    let n = g.night_view(1).unwrap();
    assert_eq!(n.outcome, Outcome::Lit);
    assert_eq!((n.minted.0, n.hearth_cut.0, n.unminted.0), (999, 200, 1));
    assert_eq!(n.throwers.iter().map(|t| t.reward.0).collect::<Vec<_>>(), vec![480, 266, 53]);
    assert!(n.throwers.iter().all(|t| t.back == t.wood && t.lost.0 == 0));
    g.assert_conserved(&everyone());
    g.assert_events_match();
}

#[test]
fn a_smoky_night_burns_part_of_the_pile_and_returns_the_rest_pro_rata() {
    let mut g = Game::new();
    g.throw(&founder(0), 10_000);
    g.throw(&founder(1), 3_333);
    g.next_night();
    // burn = 10% of 13,333 = 1,333; 12,000 back pro rata: 9,000.2 and 2,999.8, rounded down.
    assert_eq!(g.balance(&founder(0)), 99_000);
    assert_eq!(g.balance(&founder(1)), 99_666);
    let s = g.state();
    // The hearth burns 1% of 400,000 and receives the one unit of return dust.
    assert_eq!(s.hearth.0, 400_000 - 4_000 + 1);
    assert_eq!(s.supply.0, 1_000_000 - 1_333 - 4_000);
    assert_eq!(s.target.0, 18_000);
    assert_eq!(s.streak, 0);
    assert_eq!(s.records.total_burned.0, 5_333);
    let n = g.night_view(1).unwrap();
    assert_eq!(n.outcome, Outcome::Smoke);
    assert_eq!((n.burned.0, n.hearth_burned.0, n.to_hearth.0), (5_333, 4_000, 1));
    assert_eq!(n.throwers.iter().map(|t| t.lost.0).collect::<Vec<_>>(), vec![1_000, 334]);
    g.assert_conserved(&everyone());
    g.assert_events_match();
}

#[test]
fn an_empty_night_is_smoke_with_only_the_hearth_burning() {
    let mut g = Game::new();
    g.next_night();
    let s = g.state();
    assert_eq!(s.hearth.0, 396_000);
    assert_eq!(s.supply.0, 996_000);
    assert_eq!(s.target.0, 18_000);
    assert_eq!(s.records.nights_empty, 1);
    assert_eq!(g.night_view(1).unwrap().outcome, Outcome::Empty);
    let burns = g.last_events("nep141");
    assert_eq!(burns[0]["event"], "ft_burn");
    assert_eq!(burns[0]["data"][0]["owner_id"], CONTRACT);
    assert_eq!(burns[0]["data"][0]["amount"], "4000");
    g.assert_conserved(&everyone());
}

#[test]
fn the_early_weight_falls_linearly_to_one_over_the_night() {
    let mut g = Game::new();
    let w = |g: &mut Game, i: u32| g.throw(&founder(i), 100).weight.0 / 100;
    g.at(1, 0);
    assert_eq!(w(&mut g, 0), 15_000);
    g.at(1, 250);
    assert_eq!(w(&mut g, 1), 13_750);
    g.at(1, 999);
    assert_eq!(w(&mut g, 2), 10_005);
    g.tick(NIGHT_MS / 1_000 - 1);
    assert_eq!(w(&mut g, 3), 10_001, "the factor rounds towards early_max, never below 1.0");
    assert_eq!(g.state().early_bp_now, 10_001);
}

#[test]
fn wood_that_crosses_the_target_is_early_below_it_and_late_above_it() {
    let mut g = Game::new();
    g.throw(&founder(0), 19_000);
    let t = g.throw(&founder(1), 3_000);
    assert_eq!(t.weight.0, 1_000 * 15_000 + 2_000 * 5_000);
    let late = g.throw(&founder(2), 500);
    assert_eq!(late.weight.0, 500 * 5_000);
    assert!(g.state().reached);
}

#[test]
fn a_holder_may_throw_several_times_and_the_wood_adds_up() {
    let mut g = Game::new();
    g.throw(&founder(0), 1_000);
    g.at(1, 500);
    let t = g.throw(&founder(0), 1_000);
    assert_eq!(t.wood.0, 2_000);
    assert_eq!(t.weight_total.0, 1_000 * 15_000 + 1_000 * 12_500);
    assert_eq!(g.state().throwers, 1);
    let h = g.holder(&founder(0));
    assert_eq!((h.balance.0, h.wood.0), (98_000, 2_000));
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
    g.call(&founder(0), 0, |c| c.throw_wood(U128(10), None));
}

#[test]
#[should_panic(expected = "the throw is for night 1, but this is night 2")]
fn a_throw_guarded_for_an_ended_night_fails() {
    let mut g = Game::new();
    g.at(2, 10);
    g.call(&founder(0), ONE_YOCTO, |c| c.throw_wood(U128(10), Some(1)));
}

#[test]
#[should_panic(expected = "the smallest throw is 100 base units")]
fn throws_below_the_minimum_are_refused() {
    let mut c = cfg();
    c.min_throw = U128(100);
    let mut g = Game::with(c, founders());
    g.throw(&founder(0), 99);
}

#[test]
fn the_number_of_throwers_per_night_is_capped_but_seated_throwers_may_add_wood() {
    let mut c = cfg();
    c.max_throwers_per_night = 3;
    let mut g = Game::with(c, founders());
    for i in 0..3 {
        g.throw(&founder(i), 10);
    }
    let mut k = g.kindled_key(1);
    let out = g.act_throw(&mut k, 10);
    assert!(!out.ok);
    assert!(out.error.unwrap().contains("room for 3 throwers"));
    g.throw(&founder(0), 10);
    assert_eq!(g.state().throwers, 3);
    // The next night has room again.
    g.next_night();
    assert!(g.act_throw(&mut k, 10).ok);
}

#[test]
fn ft_transfer_call_to_the_contract_with_msg_throw_throws_the_wood() {
    let mut g = Game::new();
    let used = g.call(&founder(0), ONE_YOCTO, |c| c.ft_transfer_call(contract_id(), U128(5_000), None, "throw".into()));
    match used {
        near_sdk::PromiseOrValue::Value(v) => assert_eq!(v.0, 5_000),
        _ => panic!("a throw is settled in the same call"),
    }
    assert_eq!(g.holder(&founder(0)).wood.0, 5_000);
    assert_eq!(g.state().pile.0, 5_000);
    let t = g.last_events("nep141");
    assert_eq!(t[0]["event"], "ft_transfer");
    assert_eq!(t[0]["data"][0]["new_owner_id"], CONTRACT);
    assert_eq!(t[0]["data"][0]["memo"], "throw");
    let b = g.last_events("bonfire");
    assert_eq!(b[0]["event"], "throw");
}

#[test]
#[should_panic(expected = "send it with msg")]
fn ft_transfer_call_to_the_contract_with_another_msg_fails() {
    let mut g = Game::new();
    let _ = g.call(&founder(0), ONE_YOCTO, |c| c.ft_transfer_call(contract_id(), U128(5), None, "gift".into()));
}

#[test]
fn the_target_grows_after_lit_nights_and_never_shrinks_below_its_floor() {
    let mut g = Game::new();
    let mut targets = vec![];
    for _ in 0..3 {
        let t = g.state().target.0;
        g.throw(&founder(0), t);
        g.next_night();
        targets.push(g.state().target.0);
    }
    assert_eq!(targets, vec![21_000, 22_050, 23_152]);
    assert_eq!(g.state().streak, 3);
    assert_eq!(g.state().records.longest_streak, 3);
    assert_eq!(g.state().records.tallest_fire.0, 22_050);
    // Empty nights shrink it by 10% (rounded so the target rounds up) down to target_min.
    let mut seen = vec![];
    for _ in 0..20 {
        g.next_night();
        seen.push(g.state().target.0);
    }
    assert_eq!(&seen[..3], &[20_837, 18_754, 16_879]);
    assert!(seen.windows(2).all(|w| w[1] <= w[0]));
    assert_eq!(*seen.last().unwrap(), 5_000);
    assert!(seen.iter().all(|&t| t >= 5_000));
    assert_eq!(g.state().streak, 0);
    assert_eq!(g.state().records.longest_streak, 3, "the record outlives the streak");
}

#[test]
fn the_hearth_burns_its_slice_on_every_smoky_night_and_never_on_a_lit_one() {
    let mut g = Game::new();
    let mut hearth = g.state().hearth.0;
    for night in 0..10 {
        let lit = night % 3 == 0;
        let amount = if lit { g.state().target.0 } else { 100 };
        g.throw(&founder(1), amount);
        g.next_night();
        let s = g.state();
        let n = g.night_view(s.night - 1).unwrap();
        if lit {
            assert_eq!(s.hearth.0, hearth + n.hearth_cut.0);
        } else {
            assert_eq!(n.hearth_burned.0, hearth / 100);
            assert_eq!(s.hearth.0, hearth - hearth / 100 + n.to_hearth.0);
        }
        hearth = s.hearth.0;
    }
    g.assert_conserved(&everyone());
    g.assert_events_match();
}

#[test]
fn nobody_can_take_from_the_hearth_except_as_kindling() {
    let mut g = Game::new();
    let me = contract_id();
    // The contract's balance is the pile plus the hearth. Transfers to it are refused, and nothing
    // can move its balance out: it has no keys, and no method sends from it except the ritual.
    let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| g.transfer(&founder(0), &me, 1)));
    assert!(err.is_err());
    assert_eq!(g.balance(&me), 400_000);
}

#[test]
fn settle_does_nothing_before_the_night_ends_and_settles_after() {
    let mut g = Game::new();
    g.at(1, 999);
    let out = g.settle();
    assert_eq!((out.settled, out.night, out.nights_due), (0, 1, 0));
    assert!(!g.state().due);
    g.at(2, 0);
    assert!(g.state().due);
    assert_eq!(g.state().nights_due, 1);
    let out = g.settle();
    assert_eq!((out.settled, out.night, out.nights_due), (1, 2, 0));
    assert_eq!(out.ends_ms, Game::night_start(3));
    assert_eq!(g.state().last.unwrap().outcome, Outcome::Empty);
}

#[test]
fn a_throw_on_a_new_night_settles_the_old_one_first() {
    let mut g = Game::new();
    g.throw(&founder(0), 20_000);
    g.at(2, 100);
    let t = g.throw(&founder(1), 1_000);
    assert_eq!(t.night, 2);
    assert_eq!(g.state().streak, 1);
    assert_eq!(g.balance(&founder(0)), 100_000 + 800);
    assert_eq!(g.state().pile.0, 1_000);
}
