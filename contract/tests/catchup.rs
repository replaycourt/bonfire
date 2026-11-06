//! Nights nobody settled: batch catch-up, the per-call limit, history and night logs.
mod common;

use bonfire::types::Outcome;
use common::*;
use near_sdk::json_types::U128;

fn founders6() -> Vec<near_sdk::AccountId> {
    (0..6).map(founder).collect()
}

#[test]
fn a_hundred_cold_nights_settle_in_batches_of_max_catchup_and_burn_nothing() {
    let mut g = Game::new();
    g.at(101, 0);
    assert_eq!(g.state().nights_due, 100);
    let mut batches = vec![];
    loop {
        let out = g.settle();
        if out.settled == 0 {
            break;
        }
        batches.push(out.settled);
    }
    assert_eq!(batches, vec![30, 30, 30, 10]);
    let s = g.state();
    assert_eq!((s.night, s.nights_due, s.due), (101, 0, false));
    assert_eq!((s.hearth.0, s.supply.0), (400_000, 1_000_000), "cold nights burn nothing");
    assert_eq!(s.target.0, 5_000);
    assert_eq!(s.records.nights_cold, 100);
    g.assert_conserved(&founders6());
    g.assert_events_match();
}

#[test]
fn a_throw_settles_overdue_nights_first_and_waits_if_more_remain() {
    let mut g = Game::new();
    let mut k = g.kindled_key(1);
    g.at(41, 0);
    let out = g.act_throw(&mut k, 100);
    assert_eq!(out.settled, 30);
    assert!(!out.ok);
    assert!(out.error.unwrap().contains("call settle"));
    assert_eq!(g.holder(&k.account).nonce, out.nonce, "a refused action still spends the nonce");
    let out = g.act_throw(&mut k, 100);
    assert_eq!(out.settled, 10);
    assert!(out.ok);
    assert_eq!(g.state().night, 41);
    assert_eq!(g.holder(&k.account).wood.0, 100);
}

#[test]
fn a_night_with_wood_followed_by_a_long_gap_keeps_its_credit() {
    let mut g = Game::new();
    g.throw(&founder(0), 20_000);
    g.throw(&founder(1), 5_000);
    g.at(200, 0);
    let out = g.settle();
    assert_eq!(out.settled, 30);
    assert_eq!(g.view(|c| c.history(Some(1), Some(1)))[0].outcome, Outcome::Lit);
    while g.settle().settled > 0 {}
    assert_eq!(g.state().night, 200);
    // 25,000 on the pile, all in window 0: 720 shared 4 : 1.
    assert_eq!(g.balance(&founder(0)), 100_000 + 576);
    assert_eq!(g.balance(&founder(1)), 100_000 + 144);
    g.assert_conserved(&founders6());
    g.collect_all(&founders6());
    g.assert_conserved(&founders6());
    g.assert_events_match();
}

#[test]
fn history_keeps_one_row_per_night_in_a_bounded_ring() {
    let mut c = cfg();
    c.history_keep = 64;
    c.max_catchup = 1_000;
    let mut g = Game::with(c, founders());
    for n in 1..=10 {
        g.at(n, 100);
        if n % 2 == 1 {
            let t = g.state().target.0;
            g.throw(&founder(0), t);
        } else {
            g.throw(&founder(1), 77);
        }
    }
    g.next_night();
    let rows = g.view(|c| c.history(None, None));
    assert_eq!(rows.iter().map(|r| r.night).collect::<Vec<_>>(), (1..=10).collect::<Vec<_>>());
    for r in &rows {
        let n = g.night_view(r.night).unwrap();
        assert_eq!((r.outcome, r.target, r.pile, r.supply), (n.outcome, n.target, n.pile, n.supply.unwrap()));
        assert_eq!((r.minted, r.burned), (n.minted, n.burned));
    }
    assert_eq!((rows[0].outcome, rows[1].outcome), (Outcome::Lit, Outcome::Smoked));

    // 190 more nights: only the newest 64 (at least 33) stay, oldest first.
    g.at(201, 0);
    while g.settle().settled > 0 {}
    let rows = g.view(|c| c.history(None, Some(500)));
    assert_eq!(rows.last().unwrap().night, 200);
    assert!((33..=64).contains(&(rows.len() as u32)), "{} rows", rows.len());
    assert!(rows.windows(2).all(|w| w[1].night == w[0].night + 1));
    let page = g.view(|c| c.history(Some(190), Some(5)));
    assert_eq!(page.iter().map(|r| r.night).collect::<Vec<_>>(), vec![190, 191, 192, 193, 194]);
    assert!(rows.windows(2).all(|w| w[1].supply.0 == w[0].supply.0 - w[1].burned.0 + w[1].minted.0));
}

#[test]
fn night_logs_cover_the_open_night_and_the_last_log_keep_nights() {
    let mut g = Game::new();
    g.throw(&founder(2), 1_234);
    let open = g.night_view(1).unwrap();
    assert_eq!((open.outcome, open.throwers, open.pile), (Outcome::Open, 1, U128(1_234)));
    assert_eq!(open.windows[0].wood, U128(1_234));
    assert_eq!(open.firestarter, Some(founder(2)));
    for _ in 0..20 {
        g.next_night();
    }
    assert_eq!(g.state().night, 21);
    for n in 1..=20 {
        assert_eq!(g.night_view(n).is_some(), n > 20 - 14, "night {n}");
    }
    assert!(g.night_view(22).is_none());
    assert!(g.night_view(0).is_none());
}

#[test]
fn the_state_view_says_when_a_night_is_due_and_which_window_is_open() {
    let mut g = Game::new();
    let s = g.state();
    assert_eq!((s.night, s.clock_night, s.due, s.window_now), (1, 1, false, 0));
    assert_eq!(
        (s.night_start_ms, s.night_end_ms, s.window_end_ms),
        (START_MS, START_MS + NIGHT_MS, START_MS + NIGHT_MS / 4)
    );
    g.at(3, 500);
    let s = g.state();
    assert_eq!((s.night, s.clock_night, s.nights_due, s.due, s.window_now), (1, 3, 2, true, 2));
}
