//! EMBER as a token: NEP-141 (fungible token), NEP-145 (storage management) and NEP-148
//! (metadata), on the contract's own account records, using the traits, events and cross-contract
//! interfaces of near-contract-standards.
//!
//! Differences from the plain standard implementation, all on purpose:
//! - an account's balance includes what a settled night owes it and it has not collected yet;
//!   every transfer collects the sender's credit first;
//! - the contract account's balance is the pile plus the hearth; plain transfers to it are refused,
//!   and `ft_transfer_call` to it with msg `"throw:<night>"` throws the wood in the same call;
//! - an account whose storage the contract paid (a founder or a kindling claimer), and an account
//!   that took kindling, cannot unregister, so nobody can withdraw NEAR the contract staked and
//!   the once-only kindling rule holds;
//! - unregistering with `force` burns the balance with an `ft_burn` event.

use crate::events::Logs;
use crate::types::*;
use crate::{Bonfire, BonfireExt};
use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::metadata::{
    FT_METADATA_SPEC, FungibleTokenMetadata, FungibleTokenMetadataProvider,
};
use near_contract_standards::fungible_token::receiver::ext_ft_receiver;
use near_contract_standards::fungible_token::resolver::{FungibleTokenResolver, ext_ft_resolver};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_sdk::{
    AccountId, Gas, NearToken, Promise, PromiseOrValue, assert_one_yocto, env, log, near, require, serde_json,
};

const GAS_FOR_RESOLVE_TRANSFER: Gas = Gas::from_tgas(5);
/// The `msg` of an `ft_transfer_call` to the contract that throws the amount on tonight's pile.
pub const THROW_MSG: &str = "throw:";

#[near]
impl FungibleTokenCore for Bonfire {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        assert_one_yocto();
        let sender = env::predecessor_account_id();
        let mut logs = Logs::new();
        self.credit(&sender, &mut logs);
        self.do_transfer(&sender, &receiver_id, amount.0, memo.as_deref(), &mut logs)
            .unwrap_or_else(|e| env::panic_str(&e));
        logs.emit();
    }

    /// To another account: the standard transfer and `ft_on_transfer` call. To the contract itself
    /// with msg `"throw:<night>"`: throws the amount on tonight's pile right away and returns it as
    /// used; `<night>` must be tonight's number, as in `act` and `throw_wood`.
    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        assert_one_yocto();
        let sender = env::predecessor_account_id();
        let mut logs = Logs::new();
        if receiver_id == env::current_account_id() {
            let night: u32 = msg.strip_prefix(THROW_MSG).and_then(|n| n.parse().ok()).unwrap_or_else(|| {
                env::panic_str("the bonfire takes EMBER only as wood: send it with msg \"throw:<night>\"")
            });
            self.catch_up(&mut logs);
            self.credit(&sender, &mut logs);
            self.check_night(night).unwrap_or_else(|e| env::panic_str(&e));
            self.do_throw(&sender, amount.0, &mut logs).unwrap_or_else(|e| env::panic_str(&e));
            logs.emit();
            return PromiseOrValue::Value(amount);
        }
        self.credit(&sender, &mut logs);
        self.do_transfer(&sender, &receiver_id, amount.0, memo.as_deref(), &mut logs)
            .unwrap_or_else(|e| env::panic_str(&e));
        logs.emit();
        ext_ft_receiver::ext(receiver_id.clone())
            .with_unused_gas_weight(1)
            .ft_on_transfer(sender.clone(), amount, msg)
            .then(
                ext_ft_resolver::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE_TRANSFER)
                    .with_unused_gas_weight(0)
                    .ft_resolve_transfer(sender, receiver_id, amount),
            )
            .into()
    }

    fn ft_total_supply(&self) -> U128 {
        U128(self.supply)
    }

    /// Free EMBER of an account: its credited balance plus what a settled night owes it. The
    /// contract account's balance is the pile plus the hearth.
    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        if account_id == env::current_account_id() {
            return U128(self.pile + self.hearth);
        }
        U128(self.holders.get(&account_id).map_or(0, |h| h.balance + self.pending_credit(h)))
    }
}

#[near]
impl FungibleTokenResolver for Bonfire {
    /// The standard refund of what the receiver of `ft_transfer_call` did not use. If the sender
    /// unregistered in the meantime, the refund burns, with an `ft_burn` event.
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        const MAX_RESULT_LENGTH: usize = "\"+340282366920938463463374607431768211455\"".len();
        let amount = amount.0;
        let unused = env::promise_result_checked(0, MAX_RESULT_LENGTH)
            .ok()
            .and_then(|v| serde_json::from_slice::<U128>(&v).ok())
            .map_or(amount, |u| u.0)
            .min(amount);
        let held = self.holders.get(&receiver_id).map_or(0, |h| h.balance);
        let refund = unused.min(held);
        if refund == 0 {
            return U128(amount);
        }
        let mut logs = Logs::new();
        if let Some(r) = self.holders.get_mut(&receiver_id) {
            r.balance -= refund;
        }
        let used = if let Some(s) = self.holders.get_mut(&sender_id) {
            s.balance += refund;
            logs.transfer(&receiver_id, &sender_id, refund, Some("refund"));
            amount - refund
        } else {
            self.balances -= refund;
            self.supply -= refund;
            self.records.total_burned = U128(self.records.total_burned.0 + refund);
            log!("The account of the sender was deleted");
            logs.burn(&receiver_id, refund, Some("refund"));
            amount
        };
        logs.emit();
        U128(used)
    }
}

#[near]
impl StorageManagement for Bonfire {
    /// Registers `account_id` (default: the caller) for the fixed storage cost; the rest of the
    /// deposit is refunded. Registering an account that exists refunds the whole deposit.
    #[payable]
    #[allow(unused_variables)]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        let amount = env::attached_deposit();
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        let cost = self.storage_cost();
        if account == env::current_account_id() || self.holders.contains_key(&account) {
            log!("The account is already registered, refunding the deposit");
            if !amount.is_zero() {
                Promise::new(env::predecessor_account_id()).transfer(amount).detach();
            }
        } else {
            if amount < cost {
                env::panic_str("The attached deposit is less than the minimum storage balance");
            }
            self.holders.insert(account, Holder::default());
            let refund = amount.saturating_sub(cost);
            if !refund.is_zero() {
                Promise::new(env::predecessor_account_id()).transfer(refund).detach();
            }
        }
        StorageBalance { total: cost, available: NearToken::from_yoctonear(0) }
    }

    /// Nothing is ever available to withdraw: the storage balance is exactly the registration cost.
    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        require!(self.holders.contains_key(&who), format!("The account {who} is not registered"));
        if amount.is_some_and(|a| !a.is_zero()) {
            env::panic_str("The amount is greater than the available storage balance");
        }
        StorageBalance { total: self.storage_cost(), available: NearToken::from_yoctonear(0) }
    }

    /// Removes the caller's record and refunds its storage deposit. Accounts whose storage the
    /// contract paid and accounts that took kindling cannot unregister; what a settled night owes
    /// the account is collected first; wood on the burning night must be settled first; a positive
    /// balance needs `force` and burns.
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        let mut logs = Logs::new();
        self.credit(&who, &mut logs);
        logs.emit();
        let Some(h) = self.holders.get(&who).cloned() else {
            log!("The account {} is not registered", who);
            return false;
        };
        require!(h.flags & SPONSORED == 0, "the contract paid this account's storage, so it stays registered");
        require!(h.flags & KINDLED == 0, "an account that took kindling stays registered");
        require!(h.pending.is_none(), "this account has wood on tonight's fire; unregister once the night is settled");
        if h.balance > 0 && !force.unwrap_or(false) {
            env::panic_str("Can't unregister the account with the positive balance without force");
        }
        self.holders.remove(&who);
        if h.balance > 0 {
            self.balances -= h.balance;
            self.supply -= h.balance;
            self.records.total_burned = U128(self.records.total_burned.0 + h.balance);
            let mut logs = Logs::new();
            logs.burn(&who, h.balance, Some("unregister"));
            logs.emit();
        }
        Promise::new(who).transfer(self.storage_cost().saturating_add(NearToken::from_yoctonear(1))).detach();
        true
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        let cost = self.storage_cost();
        StorageBalanceBounds { min: cost, max: Some(cost) }
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        let known = account_id == env::current_account_id() || self.holders.contains_key(&account_id);
        known.then(|| StorageBalance { total: self.storage_cost(), available: NearToken::from_yoctonear(0) })
    }
}

#[near]
impl FungibleTokenMetadataProvider for Bonfire {
    /// The icon is drawn from the live state on every call: see `icon.rs`.
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: self.cfg.name.clone(),
            symbol: self.cfg.symbol.clone(),
            icon: Some(self.icon()),
            reference: None,
            reference_hash: None,
            decimals: self.cfg.decimals,
        }
    }
}

impl Bonfire {
    pub(crate) fn storage_cost(&self) -> NearToken {
        env::storage_byte_cost().saturating_mul(self.account_bytes as u128)
    }

    /// What a settled night owes this holder and it has not collected yet.
    pub(crate) fn pending_credit(&self, h: &Holder) -> u128 {
        match &h.pending {
            Some(p) if p.night < self.night => self.owed_by_night.get(&p.night).map_or(0, |o| Self::credit_of(o, p)),
            _ => 0,
        }
    }

    /// Moves free EMBER between two registered accounts.
    pub(crate) fn do_transfer(
        &mut self,
        from: &AccountId,
        to: &AccountId,
        amount: u128,
        memo: Option<&str>,
        logs: &mut Logs,
    ) -> Result<(), String> {
        if amount == 0 {
            return Err("The amount should be a positive number".into());
        }
        if from == to {
            return Err("Sender and receiver should be different".into());
        }
        if to == &env::current_account_id() {
            return Err(
                "the bonfire takes EMBER only as wood: use throw_wood, or ft_transfer_call with msg \"throw\"".into()
            );
        }
        let Some(f) = self.holders.get(from) else {
            return Err(format!("The account {from} is not registered"));
        };
        if f.balance < amount {
            let wood = f.pending.as_ref().map_or(0, |p| p.total());
            return Err(if f.balance + wood >= amount {
                "The account doesn't have enough balance: part of it is wood on tonight's fire".into()
            } else {
                "The account doesn't have enough balance".into()
            });
        }
        if !self.holders.contains_key(to) {
            return Err(format!("The account {to} is not registered"));
        }
        if let Some(f) = self.holders.get_mut(from) {
            f.balance -= amount;
        }
        if let Some(t) = self.holders.get_mut(to) {
            t.balance += amount;
            t.flags |= HELD;
        }
        logs.transfer(from, to, amount, memo);
        Ok(())
    }
}
