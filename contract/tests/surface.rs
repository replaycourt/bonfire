//! The contract's whole callable surface, read from its source: no state-changing method beyond
//! the ritual and NEP-141/145, one init, nothing that changes a parameter, deploys code or touches
//! access keys. (`build.sh` checks the same list against the exports of the built wasm.)

use std::collections::BTreeSet;

const SOURCES: [(&str, &str); 9] = [
    ("lib.rs", include_str!("../src/lib.rs")),
    ("config.rs", include_str!("../src/config.rs")),
    ("types.rs", include_str!("../src/types.rs")),
    ("views.rs", include_str!("../src/views.rs")),
    ("ritual.rs", include_str!("../src/ritual.rs")),
    ("token.rs", include_str!("../src/token.rs")),
    ("events.rs", include_str!("../src/events.rs")),
    ("icon.rs", include_str!("../src/icon.rs")),
    ("math.rs", include_str!("../src/math.rs")),
];

const CHANGING: [&str; 10] = [
    "act",
    "throw_wood",
    "claim_kindling",
    "settle",
    "ft_transfer",
    "ft_transfer_call",
    "ft_resolve_transfer",
    "storage_deposit",
    "storage_withdraw",
    "storage_unregister",
];

const VIEWS: [&str; 13] = [
    "ft_total_supply",
    "ft_balance_of",
    "ft_metadata",
    "storage_balance_bounds",
    "storage_balance_of",
    "config",
    "state",
    "records",
    "night",
    "history",
    "holder",
    "audit",
    "signing_text",
];

struct Method {
    name: String,
    mutating: bool,
    init: bool,
    private: bool,
}

/// Methods inside every `#[near] impl` block: these, and only these, become contract methods.
fn exported() -> Vec<Method> {
    let mut out = Vec::new();
    for (file, src) in SOURCES {
        let mut rest = src;
        while let Some(at) = rest.find("#[near]\nimpl") {
            let block = &rest[at..];
            let open = block.find('{').unwrap();
            let mut depth = 0;
            let mut end = open;
            for (i, ch) in block[open..].char_indices() {
                match ch {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            end = open + i;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let body = &block[open..end];
            let mut attrs = String::new();
            let lines: Vec<&str> = body.lines().map(str::trim).collect();
            for (k, &line) in lines.iter().enumerate() {
                if line.starts_with("#[") {
                    attrs.push_str(line);
                }
                if let Some(sig) = line.strip_prefix("pub fn ").or_else(|| line.strip_prefix("fn ")) {
                    let name = sig.split('(').next().unwrap().to_string();
                    // The receiver is the first parameter, on this line or the next.
                    let receiver = format!("{sig} {}", lines.get(k + 1).copied().unwrap_or(""));
                    out.push(Method {
                        name,
                        mutating: receiver.contains("&mut self"),
                        init: attrs.contains("#[init]"),
                        private: attrs.contains("#[private]"),
                    });
                    attrs.clear();
                } else if !line.starts_with("#[") && !line.starts_with("///") && !line.is_empty() {
                    attrs.clear();
                }
            }
            assert!(end > open, "unbalanced braces in {file}");
            rest = &block[end..];
        }
    }
    out
}

#[test]
fn no_state_changing_method_exists_beyond_the_ritual_and_nep141_145() {
    let methods = exported();
    let changing: BTreeSet<&str> = methods.iter().filter(|m| m.mutating).map(|m| m.name.as_str()).collect();
    let expected: BTreeSet<&str> = CHANGING.into_iter().collect();
    assert_eq!(changing, expected);
    let views: BTreeSet<&str> = methods.iter().filter(|m| !m.mutating && !m.init).map(|m| m.name.as_str()).collect();
    let expected: BTreeSet<&str> = VIEWS.into_iter().collect();
    assert_eq!(views, expected, "a view appeared or vanished: update README.md and build.sh too");
}

#[test]
fn there_is_exactly_one_init_and_it_is_private() {
    let inits: Vec<_> = exported().into_iter().filter(|m| m.init).collect();
    assert_eq!(inits.len(), 1);
    assert_eq!(inits[0].name, "new");
    assert!(inits[0].private, "only the contract account itself, at deployment, may initialize");
    let privates: BTreeSet<String> = exported().into_iter().filter(|m| m.private).map(|m| m.name).collect();
    let expected: BTreeSet<String> = ["new", "ft_resolve_transfer"].into_iter().map(String::from).collect();
    assert_eq!(privates, expected, "only init and the transfer callback are limited to the contract itself");
}

#[test]
fn nothing_deploys_code_touches_keys_or_moves_near_except_storage_refunds() {
    let forbidden = [
        "deploy_contract",
        "DeployContract",
        "deploy_global_contract",
        "use_global_contract",
        "add_full_access_key",
        "add_access_key",
        "delete_key",
        "delete_account",
        "promise_batch_action",
        ".stake(",
        "function_call_weight(",
        "state_write",
    ];
    for (file, src) in SOURCES {
        for word in forbidden {
            assert!(!src.contains(word), "{file} contains {word}");
        }
        for (i, line) in src.lines().enumerate() {
            if line.contains("Promise::new(") {
                assert!(
                    line.contains(".transfer(") || src.lines().nth(i + 1).is_some_and(|l| l.contains(".transfer(")),
                    "{file}:{}: a promise that is not a NEAR refund",
                    i + 1
                );
            }
        }
    }
}

#[test]
fn no_code_assigns_a_launch_parameter_after_init() {
    for (file, src) in SOURCES {
        for (i, line) in src.lines().enumerate() {
            let code = line.split("//").next().unwrap();
            assert!(!code.contains("&mut self.cfg"), "{file}:{}: mutable borrow of the config", i + 1);
            if let Some(eq) = code.find(" = ").or_else(|| code.find(" += ")).or_else(|| code.find(" -= ")) {
                assert!(
                    !code[..eq].contains("self.cfg") && !code[..eq].contains(".cfg."),
                    "{file}:{}: assignment to a launch parameter",
                    i + 1
                );
            }
        }
    }
    // The only place `cfg` is set is the struct literal in `new`.
    let lib = SOURCES[0].1;
    assert_eq!(lib.matches("cfg: config").count(), 1);
}
