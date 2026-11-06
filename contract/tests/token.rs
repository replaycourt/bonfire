//! EMBER as an NEP-141 token with NEP-145 storage management and NEP-148 metadata.
mod common;

use common::*;
use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::events::FtTransfer;
use near_contract_standards::fungible_token::metadata::FungibleTokenMetadataProvider;
use near_contract_standards::fungible_token::resolver::FungibleTokenResolver;
use near_contract_standards::storage_management::StorageManagement;
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{NearToken, PromiseOrValue, PromiseResult, testing_env};

#[test]
fn transfers_move_free_balance_and_log_the_standard_event() {
    let mut g = Game::new();
    g.transfer(&founder(0), &founder(1), 1_500);
    assert_eq!(g.balance(&founder(0)), 98_500);
    assert_eq!(g.balance(&founder(1)), 101_500);
    let ours = g.last_logs[0].clone();
    // The same line the standard library writes for this transfer.
    context(g.now_ms, &contract_id(), 0);
    let (a, b) = (founder(0), founder(1));
    FtTransfer { old_owner_id: &a, new_owner_id: &b, amount: U128(1_500), memo: None }.emit();
    assert_eq!(near_sdk::test_utils::get_logs()[0], ours);
}

#[test]
fn genesis_is_logged_as_mints_to_the_founders_and_the_hearth() {
    let g = Game::new();
    let e = g.events("nep141");
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["event"], "ft_mint");
    let data = e[0]["data"].as_array().unwrap();
    assert_eq!(data.len(), 7);
    assert_eq!(data[6]["owner_id"], CONTRACT);
    assert_eq!(data[6]["amount"], "400000");
    assert_eq!(data[6]["memo"], "genesis hearth");
    let mut g = g;
    assert_eq!(g.supply(), 1_000_000);
    g.assert_events_match();
}

#[test]
#[should_panic(expected = "The account nobody.testnet is not registered")]
fn transfers_to_unregistered_accounts_fail() {
    let mut g = Game::new();
    g.transfer(&founder(0), &acc("nobody.testnet"), 1);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn transfers_need_one_yocto() {
    let mut g = Game::new();
    g.call(&founder(0), 0, |c| c.ft_transfer(founder(1), U128(1), None));
}

#[test]
#[should_panic(expected = "the bonfire takes EMBER only as wood")]
fn plain_transfers_to_the_contract_fail() {
    let mut g = Game::new();
    g.transfer(&founder(0), &contract_id(), 1);
}

#[test]
fn storage_registration_follows_nep145() {
    let mut g = Game::new();
    let bounds = g.view(|c| c.storage_balance_bounds());
    let bytes = g.view(|c| c.config()).account_storage_bytes;
    assert_eq!(bounds.min, NearToken::from_yoctonear(bytes as u128 * 10u128.pow(19)));
    assert_eq!(bounds.max, Some(bounds.min));
    eprintln!("one account record: {bytes} bytes = {} yoctoNEAR", bounds.min.as_yoctonear());
    let w = acc("wallet.testnet");
    assert!(g.view(|c| c.storage_balance_of(acc("wallet.testnet"))).is_none());
    let paid = g.call(&w, bounds.min.as_yoctonear() * 3, |c| c.storage_deposit(None, None));
    assert_eq!(paid.total, bounds.min);
    let refunds = near_sdk::test_utils::get_created_receipts();
    assert_eq!(refunds.len(), 1, "the excess deposit is refunded");
    assert!(g.view(|c| c.storage_balance_of(acc("wallet.testnet"))).is_some());
    assert!(!g.holder(&w).sponsored);
    // The contract account counts as registered: it holds the pile and the hearth.
    assert!(g.view(|c| c.storage_balance_of(contract_id())).is_some());
    // Registering again refunds everything.
    g.call(&w, 5, |c| c.storage_deposit(None, None));
    assert_eq!(near_sdk::test_utils::get_created_receipts().len(), 1);
}

#[test]
#[should_panic(expected = "less than the minimum storage balance")]
fn a_short_storage_deposit_fails() {
    let mut g = Game::new();
    g.call(&acc("wallet.testnet"), 1, |c| c.storage_deposit(None, None));
}

#[test]
fn a_self_paid_account_may_unregister_and_a_forced_balance_burns_with_an_event() {
    let mut g = Game::new();
    let w = acc("wallet.testnet");
    g.register(&w);
    assert!(g.call(&w, ONE_YOCTO, |c| c.storage_unregister(None)));
    assert!(!g.holder(&w).registered);
    g.register(&w);
    g.transfer(&founder(0), &w, 700);
    assert!(g.call(&w, ONE_YOCTO, |c| c.storage_unregister(Some(true))));
    assert_eq!(g.supply(), 1_000_000 - 700);
    let e = g.last_events("nep141");
    assert_eq!(e[0]["event"], "ft_burn");
    assert_eq!(e[0]["data"][0]["memo"], "unregister");
    let mut all: Vec<_> = (0..6).map(founder).collect();
    all.push(w);
    g.assert_conserved(&all);
    g.assert_events_match();
}

#[test]
#[should_panic(expected = "without force")]
fn unregistering_a_positive_balance_needs_force() {
    let mut g = Game::new();
    let w = acc("wallet.testnet");
    g.register(&w);
    g.transfer(&founder(0), &w, 1);
    g.call(&w, ONE_YOCTO, |c| c.storage_unregister(None));
}

#[test]
#[should_panic(expected = "the contract paid this account's storage")]
fn a_sponsored_account_cannot_unregister() {
    let mut g = Game::new();
    g.call(&founder(0), ONE_YOCTO, |c| c.storage_unregister(Some(true)));
}

#[test]
#[should_panic(expected = "an account that took kindling stays registered")]
fn a_kindled_account_cannot_unregister() {
    let mut g = Game::new();
    let w = acc("wallet.testnet");
    g.register(&w);
    g.kindle(&w);
    g.call(&w, ONE_YOCTO, |c| c.storage_unregister(Some(true)));
}

#[test]
#[should_panic(expected = "wood on tonight's fire")]
fn an_account_with_wood_on_the_pile_cannot_unregister() {
    let mut g = Game::new();
    let w = acc("wallet.testnet");
    g.register(&w);
    g.transfer(&founder(0), &w, 50);
    g.throw(&w, 50);
    g.call(&w, ONE_YOCTO, |c| c.storage_unregister(Some(true)));
}

#[test]
fn unregistering_an_unknown_account_returns_false() {
    let mut g = Game::new();
    assert!(!g.call(&acc("ghost.testnet"), ONE_YOCTO, |c| c.storage_unregister(None)));
}

fn resolve(g: &mut Game, result: PromiseResult, sender: &str, receiver: &str, amount: u128) -> u128 {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id()).predecessor_account_id(contract_id()).block_timestamp(g.now_ms * 1_000_000);
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_parameters::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
    let r = g.c.ft_resolve_transfer(acc(sender), acc(receiver), U128(amount)).0;
    g.logs.extend(near_sdk::test_utils::get_logs());
    r
}

#[test]
fn transfer_call_refunds_what_the_receiver_did_not_use() {
    let mut g = Game::new();
    let r = g.call(&founder(0), ONE_YOCTO, |c| c.ft_transfer_call(founder(1), U128(100), None, "swap".into()));
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    assert_eq!(g.balance(&founder(1)), 100_100);
    let used =
        resolve(&mut g, PromiseResult::Successful(b"\"30\"".to_vec()), "founder0.testnet", "founder1.testnet", 100);
    assert_eq!(used, 70);
    assert_eq!(g.balance(&founder(0)), 99_930);
    assert_eq!(g.balance(&founder(1)), 100_070);
    // A failed receiver call refunds everything.
    let _ = g.call(&founder(0), ONE_YOCTO, |c| c.ft_transfer_call(founder(1), U128(10), None, "swap".into()));
    assert_eq!(resolve(&mut g, PromiseResult::Failed, "founder0.testnet", "founder1.testnet", 10), 0);
    assert_eq!(g.balance(&founder(0)), 99_930);
    let founders: Vec<_> = (0..6).map(founder).collect();
    g.assert_conserved(&founders);
    g.assert_events_match();
}

#[test]
fn a_refund_to_a_sender_who_unregistered_meanwhile_burns() {
    let mut g = Game::new();
    let w = acc("wallet.testnet");
    g.register(&w);
    g.transfer(&founder(0), &w, 100);
    let _ = g.call(&w, ONE_YOCTO, |c| c.ft_transfer_call(founder(1), U128(100), None, "swap".into()));
    g.call(&w, ONE_YOCTO, |c| c.storage_unregister(None));
    let used =
        resolve(&mut g, PromiseResult::Successful(b"\"40\"".to_vec()), "wallet.testnet", "founder1.testnet", 100);
    assert_eq!(used, 100);
    assert_eq!(g.supply(), 1_000_000 - 40);
    let founders: Vec<_> = (0..6).map(founder).collect();
    g.assert_conserved(&founders);
    g.assert_events_match();
}

#[test]
fn the_contract_balance_is_the_pile_plus_the_hearth() {
    let mut g = Game::new();
    g.throw(&founder(0), 3_000);
    assert_eq!(g.balance(&contract_id()), 403_000);
    let total: u128 = (0..6).map(|i| g.balance(&founder(i))).sum::<u128>() + g.balance(&contract_id());
    assert_eq!(total, g.supply());
}

#[test]
fn metadata_is_nep148_with_a_live_icon() {
    let mut g = Game::new();
    let m = g.view(|c| c.ft_metadata());
    m.assert_valid();
    assert_eq!((m.name.as_str(), m.symbol.as_str(), m.decimals), ("Bonfire Ember", "EMBER", 0));
    let before = m.icon.unwrap();
    assert!(before.starts_with("data:image/svg+xml,"));
    g.throw(&founder(0), 20_000);
    g.next_night();
    let after = g.view(|c| c.ft_metadata()).icon.unwrap();
    assert_ne!(before, after, "the icon follows the fire");
}
