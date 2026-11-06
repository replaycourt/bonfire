//! Pull payments: a settled night only records its aggregates, and every thrower's wood and share
//! are credited when the thrower next acts, throws, transfers or claims, or when anyone collects
//! for it. `ft_balance_of` counts the credit from the moment the night is settled.
mod common;

use bonfire::types::Outcome;
use common::*;
use near_sdk::json_types::U128;

fn everyone() -> Vec<near_sdk::AccountId> {
    (0..6).map(founder).collect()
}

#[test]
fn the_balance_counts_the_credit_before_it_is_collected() {
    let mut g = Game::new();
    g.throw(&founder(0), 20_000);
    assert_eq!(g.balance(&founder(0)), 80_000, "wood on the open pile is not in the balance");
    g.next_night();
    let h = g.holder(&founder(0));
    assert_eq!((h.credited.0, h.pending.0, h.balance.0), (80_000, 20_720, 100_720));
    assert_eq!(g.balance(&founder(0)), 100_720);
    // Anyone may collect for anyone; the credit moves with an ft_transfer from the contract.
    assert_eq!(g.collect(&founder(0)), 20_720);
    let e = g.last_events("nep141");
    assert_eq!(e[0]["event"], "ft_transfer");
    assert_eq!(e[0]["data"][0]["old_owner_id"], CONTRACT);
    assert_eq!(e[0]["data"][0]["new_owner_id"], "founder0.testnet");
    assert_eq!(e[0]["data"][0]["memo"], "night 1 collect");
    let h = g.holder(&founder(0));
    assert_eq!((h.credited.0, h.pending.0, h.wood_night), (100_720, 0, None));
    // Collecting again, or for someone with nothing owed, collects nothing.
    assert_eq!(g.collect(&founder(0)), 0);
    assert_eq!(g.collect(&founder(3)), 0);
    assert_eq!(g.collect(&acc("stranger.testnet")), 0);
    g.assert_conserved(&everyone());
    g.assert_events_match();
}

#[test]
fn wood_on_the_open_night_cannot_be_collected() {
    let mut g = Game::new();
    g.throw(&founder(0), 5_000);
    assert_eq!(g.collect(&founder(0)), 0);
    assert_eq!(g.holder(&founder(0)).wood.0, 5_000);
}

#[test]
fn a_holder_who_comes_back_after_thirty_nights_gets_exactly_its_credit() {
    let mut g = Game::new();
    g.at(1, 0);
    g.throw(&founder(0), 12_000);
    g.at(1, 300);
    g.throw(&founder(1), 8_000);
    g.next_night();
    // Founder 1 collects at once; founder 0 stays away.
    let early = g.collect(&founder(1));
    assert_eq!(early, 8_000 + 720 * 128 / 500);
    let owed = g.holder(&founder(0)).pending.0;
    assert_eq!(owed, 12_000 + 720 * 372 / 500);
    // Thirty nights later, through lit, smoky and cold nights of others, the credit is unchanged.
    for night in 2..32 {
        match night % 3 {
            0 => {
                let t = g.state().target.0;
                g.throw(&founder(2), t);
            }
            1 => {
                g.throw(&founder(3), 1_000);
            }
            _ => {}
        }
        g.next_night();
        g.collect(&founder(2));
        g.collect(&founder(3));
        assert_eq!(g.holder(&founder(0)).pending.0, owed);
        assert_eq!(g.balance(&founder(0)), 88_000 + owed);
    }
    assert_eq!(g.state().owed_nights, 1, "only night 1 still owes anyone");
    assert_eq!(g.night_view(1), None, "beyond log_keep, but its record waits for the last thrower");
    let hearth = g.state().hearth.0;
    // Coming back: its first action collects.
    let t = g.throw(&founder(0), 1_000);
    assert_eq!(t.collected.0, owed);
    let s = g.state();
    assert_eq!(s.owed_nights, 0);
    assert_eq!(s.hearth.0, hearth + (720 - 535 - 184), "the night's rounding dust reaches the hearth last");
    g.assert_conserved(&everyone());
    g.assert_events_match();
}

#[test]
fn every_balance_changing_call_collects_first() {
    let mut g = Game::new();
    let mut k = g.kindled_key(1);
    let w = acc("wallet.testnet");
    g.register(&w);
    g.transfer(&founder(0), &w, 1_000);
    g.throw(&founder(0), 10_000);
    g.throw(&founder(1), 10_000);
    g.throw(&w, 1_000);
    assert!(g.act_throw(&mut k, 250).ok);
    g.next_night();
    // A transfer can spend the credit at once.
    let pending = g.holder(&founder(0)).pending.0;
    assert!(pending > 10_000);
    g.transfer(&founder(0), &founder(5), 90_010);
    assert_eq!(g.holder(&founder(0)).credited.0, 89_000 + pending - 90_010);
    // ft_transfer_call collects too.
    let p1 = g.holder(&founder(1)).pending.0;
    let _ = g.call(&founder(1), ONE_YOCTO, |c| {
        near_contract_standards::fungible_token::core::FungibleTokenCore::ft_transfer_call(
            c,
            founder(4),
            U128(1),
            None,
            "x".into(),
        )
    });
    assert_eq!(g.holder(&founder(1)).credited.0, 90_000 + p1 - 1);
    // Any act collects, even one that is refused.
    let out = g.act_transfer(&mut k, &acc("nobody.testnet"), 1);
    assert!(!out.ok);
    assert!(out.collected.0 > 250);
    assert_eq!(g.holder(&k.account).pending.0, 0);
    // Unregistering collects before it checks the balance.
    let pw = g.holder(&w).pending.0;
    assert!(pw > 1_000);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        g.call(&w, ONE_YOCTO, |c| {
            near_contract_standards::storage_management::StorageManagement::storage_unregister(c, None)
        })
    }));
    assert!(r.is_err(), "a positive balance needs force");
}

#[test]
fn the_collect_action_collects_for_a_browser_key() {
    let mut g = Game::new();
    let mut k = g.kindled_key(1);
    g.act_throw(&mut k, 250);
    g.throw(&founder(0), 19_750);
    g.next_night();
    let out = g.act_collect(&mut k);
    assert!(out.ok);
    assert!(out.collected.0 > 250);
    assert_eq!(g.holder(&k.account).credited.0, out.collected.0);
}

#[test]
fn a_smoky_night_returns_the_wood_lazily() {
    let mut g = Game::new();
    g.throw(&founder(0), 6_000);
    g.throw(&founder(1), 4_000);
    g.next_night();
    // 3% of 10,000 burns; 9,700 comes back as 5,820 and 3,880.
    assert_eq!(g.holder(&founder(0)).pending.0, 5_820);
    assert_eq!(g.holder(&founder(1)).pending.0, 3_880);
    assert_eq!(g.night_view(1).unwrap().outcome, Outcome::Smoked);
    g.collect_all(&everyone());
    assert_eq!(g.state().owed.0, 0);
    g.assert_conserved(&everyone());
    g.assert_events_match();
}

#[test]
fn the_record_of_a_night_goes_when_its_last_thrower_collects() {
    let mut g = Game::new();
    for i in 0..3 {
        g.throw(&founder(i), 7_000);
    }
    g.next_night();
    let left = |g: &mut Game| g.night_view(1).unwrap().uncollected.unwrap();
    assert_eq!(left(&mut g), 3);
    g.collect(&founder(0));
    assert_eq!(left(&mut g), 2);
    g.collect(&founder(1));
    g.collect(&founder(2));
    assert_eq!(left(&mut g), 0);
    assert_eq!(g.night_view(1).unwrap().owed, Some(U128(0)));
    assert_eq!(g.state().owed_nights, 0);
}
