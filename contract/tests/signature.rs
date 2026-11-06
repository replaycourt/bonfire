//! `act`: signatures, nonces, night binding, and what a refused action does.
mod common;

use common::*;

fn kindle_text(n: u32) -> String {
    format!(r#"{{"claim_kindling":{{"night":{n}}}}}"#)
}

fn relay(g: &mut Game, hex: &str, nonce: u64, action: &str, sig: String) -> bonfire::types::ActOutcome {
    let (hex, action) = (hex.to_string(), action.to_string());
    g.call(&acc("relayer.testnet"), 0, |c| c.act(hex, nonce, action, sig))
}

#[test]
fn a_signed_action_acts_for_the_implicit_account_of_the_key() {
    let mut g = Game::new();
    let mut k = Key::new(1);
    let out = g.act_kindle(&mut k);
    assert!(out.ok);
    assert_eq!(out.nonce, 1);
    assert_eq!(k.account.as_str().len(), 64);
    assert_eq!(g.balance(&k.account), 250);
    let t = g.act_throw(&mut k, 100);
    assert!(t.ok);
    assert_eq!(g.holder(&k.account).wood.0, 100);
    let to = founder(3);
    assert!(g.act_transfer(&mut k, &to, 150).ok);
    assert_eq!(g.balance(&to), 100_150);
    assert_eq!(g.balance(&k.account), 0);
    assert_eq!(g.holder(&k.account).nonce, 3);
}

#[test]
fn anyone_can_relay_a_signed_action() {
    let mut g = Game::new();
    let k = Key::new(1);
    let text = kindle_text(1);
    let sig = k.sign(CONTRACT, 1, &text);
    let (hex, t) = (k.hex.clone(), text.clone());
    let out = g.call(&acc("some-stranger.testnet"), 0, |c| c.act(hex, 1, t, sig));
    assert!(out.ok);
}

#[test]
fn the_signing_text_view_matches_the_signed_message() {
    let mut g = Game::new();
    let t = g.view(|c| c.signing_text(7, "{}".into()));
    assert_eq!(t, "bonfire:v1:bonfire.testnet:7:{}");
}

#[test]
#[should_panic(expected = "nonce already used")]
fn a_replayed_message_is_rejected() {
    let mut g = Game::new();
    let mut k = Key::new(1);
    g.act_kindle(&mut k);
    let text = kindle_text(1);
    let sig = k.sign(CONTRACT, 1, &text);
    relay(&mut g, &k.hex.clone(), 1, &text, sig);
}

#[test]
#[should_panic(expected = "nonce already used")]
fn an_older_nonce_is_rejected() {
    let mut g = Game::new();
    let mut k = g.kindled_key(1);
    k.nonce = 10;
    g.act_throw(&mut k, 100);
    let text = r#"{"throw":{"amount":"100","night":1}}"#;
    let sig = k.sign(CONTRACT, 5, text);
    relay(&mut g, &k.hex.clone(), 5, text, sig);
}

#[test]
fn nonces_may_skip_ahead() {
    let mut g = Game::new();
    let mut k = g.kindled_key(1);
    k.nonce = 1_000;
    let out = g.act_throw(&mut k, 100);
    assert!(out.ok);
    assert_eq!(out.nonce, 1_001);
}

#[test]
#[should_panic(expected = "bad signature")]
fn a_tampered_action_fails() {
    let mut g = Game::new();
    let k = g.kindled_key(1);
    let signed = r#"{"throw":{"amount":"100","night":1}}"#;
    let sent = r#"{"throw":{"amount":"200","night":1}}"#;
    let sig = k.sign(CONTRACT, 2, signed);
    relay(&mut g, &k.hex.clone(), 2, sent, sig);
}

#[test]
#[should_panic(expected = "bad signature")]
fn a_tampered_nonce_fails() {
    let mut g = Game::new();
    let k = g.kindled_key(1);
    let text = r#"{"throw":{"amount":"100","night":1}}"#;
    let sig = k.sign(CONTRACT, 2, text);
    relay(&mut g, &k.hex.clone(), 3, text, sig);
}

#[test]
#[should_panic(expected = "bad signature")]
fn another_keys_signature_fails() {
    let mut g = Game::new();
    let k = g.kindled_key(1);
    let other = Key::new(2);
    let text = r#"{"throw":{"amount":"100","night":1}}"#;
    let sig = other.sign(CONTRACT, 2, text);
    relay(&mut g, &k.hex.clone(), 2, text, sig);
}

#[test]
#[should_panic(expected = "bad signature")]
fn a_signature_for_another_deployment_fails() {
    let mut g = Game::new();
    let k = Key::new(1);
    let text = kindle_text(1);
    let sig = k.sign("other-bonfire.testnet", 1, &text);
    relay(&mut g, &k.hex.clone(), 1, &text, sig);
}

#[test]
#[should_panic(expected = "bad signature")]
fn a_garbage_signature_fails() {
    let mut g = Game::new();
    let k = Key::new(1);
    relay(&mut g, &k.hex.clone(), 1, &kindle_text(1), "ab".repeat(64));
}

#[test]
#[should_panic(expected = "bad public key")]
fn an_uppercase_public_key_is_rejected() {
    let mut g = Game::new();
    let k = Key::new(1);
    let text = kindle_text(1);
    let sig = k.sign(CONTRACT, 1, &text);
    relay(&mut g, &k.hex.to_uppercase(), 1, &text, sig);
}

#[test]
#[should_panic(expected = "bad signature encoding")]
fn a_short_signature_is_rejected() {
    let mut g = Game::new();
    let k = Key::new(1);
    relay(&mut g, &k.hex.clone(), 1, &kindle_text(1), "00".into());
}

#[test]
#[should_panic(expected = "malformed action")]
fn an_unknown_field_is_malformed() {
    let mut g = Game::new();
    let mut k = Key::new(1);
    g.act(&mut k, r#"{"claim_kindling":{"night":1,"extra":1}}"#);
}

#[test]
#[should_panic(expected = "malformed action")]
fn an_unknown_action_is_malformed() {
    let mut g = Game::new();
    let mut k = Key::new(1);
    g.act(&mut k, r#"{"withdraw_hearth":{"night":1}}"#);
}

#[test]
#[should_panic(expected = "nonce too large")]
fn nonces_stay_inside_the_javascript_safe_range() {
    let mut g = Game::new();
    let mut k = Key::new(1);
    k.nonce = bonfire::config::MAX_NONCE;
    g.act_kindle(&mut k);
}

#[test]
#[should_panic(expected = "action too long")]
fn long_actions_are_rejected() {
    let mut g = Game::new();
    let mut k = Key::new(1);
    g.act(&mut k, &" ".repeat(bonfire::config::MAX_ACTION_BYTES + 1));
}

#[test]
fn an_action_for_another_night_is_refused_and_spends_the_nonce() {
    let mut g = Game::new();
    let mut k = g.kindled_key(1);
    let out = g.act(&mut k, r#"{"throw":{"amount":"100","night":2}}"#);
    assert!(!out.ok);
    assert_eq!(out.error.as_deref(), Some("the action is for night 2, but this is night 1"));
    assert_eq!(g.holder(&k.account).nonce, out.nonce);
    // A throw signed during night 1 cannot be replayed into night 2 under a fresh nonce either:
    // the night is part of what was signed.
    g.next_night();
    let text = r#"{"throw":{"amount":"100","night":1}}"#;
    let sig = k.sign(CONTRACT, 50, text);
    let out = relay(&mut g, &k.hex.clone(), 50, text, sig);
    assert!(!out.ok);
    assert_eq!(g.holder(&k.account).wood.0, 0);
}

#[test]
fn a_refused_action_of_an_unknown_key_leaves_no_trace() {
    let mut g = Game::new();
    let mut k = Key::new(1);
    let out = g.act_throw(&mut k, 100);
    assert!(!out.ok);
    assert!(out.error.unwrap().contains("not registered"));
    assert!(!g.holder(&k.account).registered);
    assert!(g.last_logs.is_empty());
}

#[test]
fn a_refused_transfer_changes_nothing_but_the_nonce() {
    let mut g = Game::new();
    let mut k = g.kindled_key(1);
    let out = g.act_transfer(&mut k, &acc("nobody.testnet"), 10);
    assert!(out.error.unwrap().contains("not registered"));
    let out = g.act_transfer(&mut k, &contract_id(), 10);
    assert!(out.error.unwrap().contains("only as wood"));
    let out = g.act_transfer(&mut k, &founder(0), 251);
    assert!(out.error.unwrap().contains("enough balance"));
    assert_eq!(g.balance(&k.account), 250);
    assert_eq!(g.holder(&k.account).nonce, 4);
}
