//! Conservation under random play: whatever anyone does, in whatever order, over many nights,
//! supply == free balances + pile + hearth after every single call, the tracked totals match a
//! recomputation, and the event log alone rebuilds every balance.
mod common;

use bonfire::config::*;
use bonfire::types::Outcome;
use common::*;
use near_sdk::AccountId;
use near_sdk::json_types::U128;

fn wide(rng: &mut Rng, max: u128) -> u128 {
    if max == 0 {
        return 0;
    }
    ((rng.next() as u128) << 64 | rng.next() as u128) % (max + 1)
}

fn scaled(unit: u128) -> (Config, Vec<Founder>) {
    let mut c = cfg();
    c.decimals = if unit == 1 { 0 } else { 18 };
    for x in [&mut c.hearth_genesis, &mut c.target_start, &mut c.target_min, &mut c.kindling] {
        *x = U128(x.0 * unit);
    }
    c.target_start = U128(c.target_start.0 / 4);
    c.min_throw = U128(unit / 10 + 1);
    c.max_throwers_per_night = 12;
    c.kindling_per_night = 5;
    c.max_catchup = 7;
    c.log_keep = 5;
    c.history_keep = 64;
    let f = founders().into_iter().map(|f| Founder { amount: U128(f.amount.0 * unit), ..f }).collect();
    (c, f)
}

fn run(seed: u64, unit: u128, steps: u32) {
    let (c, f) = scaled(unit);
    let (max_catchup, max_throwers, min_throw) = (c.max_catchup, c.max_throwers_per_night, c.min_throw.0);
    let mut g = Game::with(c.clone(), f);
    let mut rng = Rng(seed);
    let mut keys: Vec<Key> = (0..15).map(|i| Key::new(1_000 + i)).collect();
    let wallets: Vec<AccountId> = (0..3).map(|i| acc(&format!("wallet{i}.testnet"))).collect();
    for w in &wallets {
        g.register(w);
    }
    let mut everyone: Vec<AccountId> = (0..6).map(founder).collect();
    everyone.extend(keys.iter().map(|k| k.account.clone()));
    everyone.extend(wallets.iter().cloned());
    let named: Vec<AccountId> = (0..6).map(founder).chain(wallets.iter().cloned()).collect();

    let (mut thrown, mut kindled, mut moved, mut refused) = (0, 0, 0, 0);
    for step in 0..steps {
        match rng.below(12) {
            0..=3 => {
                let i = rng.below(keys.len() as u64) as usize;
                let bal = g.balance(&keys[i].account);
                let amount = wide(&mut rng, bal + bal / 5 + min_throw);
                let out = g.act_throw(&mut keys[i], amount);
                if out.ok { thrown += 1 } else { refused += 1 }
            }
            4 => {
                let i = rng.below(keys.len() as u64) as usize;
                let out = g.act_kindle(&mut keys[i]);
                if out.ok { kindled += 1 } else { refused += 1 }
            }
            5 => {
                let i = rng.below(keys.len() as u64) as usize;
                let to = everyone[rng.below(everyone.len() as u64) as usize].clone();
                let bal = g.balance(&keys[i].account);
                let out = g.act_transfer(&mut keys[i], &to, wide(&mut rng, bal + 2));
                if out.ok { moved += 1 } else { refused += 1 }
            }
            6 | 7 => {
                // Wallet calls panic on refusal, so they are only made when they must succeed.
                let who = named[rng.below(named.len() as u64) as usize].clone();
                let s = g.state();
                let h = g.holder(&who);
                let seated = h.wood.0 > 0 || s.throwers < max_throwers;
                let amount = wide(&mut rng, h.balance.0 / 3);
                if s.nights_due == 0 && seated && amount >= min_throw {
                    g.throw(&who, amount);
                    thrown += 1;
                }
            }
            8 => {
                let from = named[rng.below(named.len() as u64) as usize].clone();
                let to = everyone[rng.below(everyone.len() as u64) as usize].clone();
                let bal = g.balance(&from);
                let amount = wide(&mut rng, bal / 4);
                if from != to && amount > 0 && g.holder(&to).registered {
                    g.transfer(&from, &to, amount);
                    moved += 1;
                }
            }
            9 => {
                g.settle();
            }
            10 => {
                g.tick(wide(&mut rng, NIGHT_MS as u128 / 2) as u64);
            }
            _ => {
                if rng.below(8) == 0 {
                    g.tick(NIGHT_MS * rng.below(max_catchup as u64 * 3));
                }
            }
        }
        g.tick(rng.below(NIGHT_MS / 12));
        g.assert_conserved(&everyone);
        let s = g.state();
        assert!(s.target.0 >= c.target_min.0 && s.target.0 <= SUPPLY_CAP, "target out of bounds: {s:?}");
        assert!(s.throwers <= max_throwers);
        if step % 100 == 99 {
            g.assert_events_match();
        }
    }
    while g.settle().settled > 0 {}
    g.assert_conserved(&everyone);
    g.assert_events_match();

    // The history agrees with the night logs and with the streak.
    let rows = g.view(|c| c.history(None, Some(500)));
    let s = g.state();
    let trailing_lit = rows.iter().rev().take_while(|r| r.outcome == Outcome::Lit).count() as u32;
    if (rows.len() as u32) > s.streak {
        assert_eq!(trailing_lit, s.streak);
    }
    for r in rows.iter().rev().take(c.log_keep as usize) {
        let n = g.night_view(r.night).unwrap();
        assert_eq!((n.outcome, n.supply.unwrap()), (r.outcome, r.supply));
    }
    eprintln!(
        "seed {seed}: {} nights, {} lit, {} smoke, {} empty; {thrown} throws, {kindled} kindlings, {moved} transfers, {refused} refusals",
        s.night - 1,
        s.records.nights_lit,
        s.records.nights_smoke,
        s.records.nights_empty
    );
    assert!(thrown > steps / 10, "the run has to mean something: only {thrown} throws");
    assert!(s.records.nights_lit > 0 && s.records.nights_smoke > 0, "both outcomes must occur");
}

#[test]
fn conservation_holds_under_random_play_in_whole_units() {
    for seed in [1, 2, 3] {
        run(0x5EED_0000 + seed, 1, 700);
    }
}

#[test]
fn conservation_holds_under_random_play_with_eighteen_decimals() {
    for seed in [7, 8] {
        run(0xDEC1_0000 + seed, 10u128.pow(18), 700);
    }
}
