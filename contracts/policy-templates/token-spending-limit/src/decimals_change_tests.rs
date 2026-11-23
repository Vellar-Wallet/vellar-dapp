#![cfg(test)]

//! A bound token's `decimals()` changes after the policy was deployed (#821).
//!
//! A SEP-41 token's decimals are not normally mutable, but if the bound token
//! address were ever redeployed or upgraded with a different value, the deployed
//! policy's math must not silently become wrong. The policy stores its limit in
//! the token's base units at deploy time and only ever compares raw i128
//! amounts; it never reads `decimals()`. These tests pin that:
//!
//! * the stored limit and token binding do not change when decimals change,
//! * enforcement stays exact in base units on both sides of the change,
//! * cumulative accounting carries across the change,
//! * the policy never calls `decimals()` at all (a token that traps on it is
//!   still governed correctly),
//! * a token redeployed at a NEW address is not governed by the old binding.

extern crate std;

use smart_wallet_interface::types::SignerKey;
use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contractimpl, symbol_short,
    testutils::Address as _,
    Address, Env, IntoVal, Vec,
};

use crate::{Contract, ContractClient};

// ----- Mock token whose decimals can change (and can be made to trap) -----

#[contract]
struct MockToken;

#[contractimpl]
impl MockToken {
    pub fn __constructor(env: Env, decimals: u32) {
        env.storage().instance().set(&symbol_short!("DEC"), &decimals);
    }

    pub fn set_decimals(env: Env, decimals: u32) {
        env.storage().instance().set(&symbol_short!("DEC"), &decimals);
    }

    /// When set, `decimals()` panics: any caller that reads it fails loudly.
    pub fn trap_decimals(env: Env, trap: bool) {
        env.storage().instance().set(&symbol_short!("TRAP"), &trap);
    }

    pub fn decimals(env: Env) -> u32 {
        let trap: bool = env
            .storage()
            .instance()
            .get(&symbol_short!("TRAP"))
            .unwrap_or(false);
        if trap {
            panic!("decimals() must not be read by the policy");
        }
        env.storage().instance().get(&symbol_short!("DEC")).unwrap()
    }
}

// ----- Fixture -----

const DAY: u64 = 60 * 60 * 24;
/// 10 whole units of a 7-decimal token, in base units.
const TEN_UNITS_7DP: i128 = 100_000_000;
const ONE_UNIT_7DP: i128 = 10_000_000;

struct Fixture {
    env: Env,
    policy: ContractClient<'static>,
    wallet: Address,
    token: Address,
    token_client: MockTokenClient<'static>,
}

fn setup(limit: i128) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let wallet = Address::generate(&env);
    let token = env.register(MockToken, (7u32,));
    let token_client = MockTokenClient::new(&env, &token);
    let policy_id = env.register(Contract, (wallet.clone(), token.clone(), limit, DAY));
    let policy = ContractClient::new(&env, &policy_id);
    policy.install(&wallet);

    Fixture {
        env,
        policy,
        wallet,
        token,
        token_client,
    }
}

fn signer_key(fx: &Fixture) -> SignerKey {
    SignerKey::Policy(fx.policy.address.clone())
}

fn transfer_ctx(fx: &Fixture, token: &Address, amount: i128) -> Vec<Context> {
    let dest = Address::generate(&fx.env);
    let args: Vec<soroban_sdk::Val> = (fx.wallet.clone(), dest, amount).into_val(&fx.env);
    Vec::from_array(
        &fx.env,
        [Context::Contract(ContractContext {
            contract: token.clone(),
            fn_name: symbol_short!("transfer"),
            args,
        })],
    )
}

fn spend(fx: &Fixture, amount: i128) {
    fx.policy
        .policy__(&fx.wallet, &signer_key(fx), &transfer_ctx(fx, &fx.token, amount));
}

fn try_spend(fx: &Fixture, amount: i128) -> bool {
    fx.policy
        .try_policy__(&fx.wallet, &signer_key(fx), &transfer_ctx(fx, &fx.token, amount))
        .is_ok()
}

// ----- Tests -----

#[test]
fn stored_limit_and_token_binding_are_unchanged_when_decimals_change() {
    let fx = setup(TEN_UNITS_7DP);
    let before = fx.policy.config();

    fx.token_client.set_decimals(&18u32);

    let after = fx.policy.config();
    assert_eq!(before, after);
    assert_eq!(after.daily_limit, TEN_UNITS_7DP);
    assert_eq!(after.token, fx.token);
}

#[test]
fn limit_is_still_enforced_exactly_in_base_units_after_decimals_increase() {
    let fx = setup(TEN_UNITS_7DP);
    fx.token_client.set_decimals(&18u32);

    // Exactly the limit, in the base units the policy was deployed with.
    assert!(try_spend(&fx, TEN_UNITS_7DP));
}

#[test]
fn one_base_unit_over_the_limit_is_still_rejected_after_decimals_increase() {
    let fx = setup(TEN_UNITS_7DP);
    fx.token_client.set_decimals(&18u32);

    assert!(!try_spend(&fx, TEN_UNITS_7DP + 1));
}

#[test]
fn one_base_unit_over_the_limit_is_still_rejected_after_decimals_decrease() {
    let fx = setup(TEN_UNITS_7DP);
    fx.token_client.set_decimals(&2u32);

    // Boundary: the policy does not rescale to the new precision, so the cap
    // stays exactly where it was deployed.
    assert!(try_spend(&fx, TEN_UNITS_7DP));
    let fx2 = setup(TEN_UNITS_7DP);
    fx2.token_client.set_decimals(&2u32);
    assert!(!try_spend(&fx2, TEN_UNITS_7DP + 1));
}

#[test]
fn cumulative_accounting_carries_across_the_decimals_change() {
    let fx = setup(TEN_UNITS_7DP);

    // Spend 6 units before the change, 4 after: exactly the limit.
    spend(&fx, 6 * ONE_UNIT_7DP);
    fx.token_client.set_decimals(&18u32);
    spend(&fx, 4 * ONE_UNIT_7DP);

    // The window is now fully used; even one more base unit is rejected.
    assert!(!try_spend(&fx, 1));
}

#[test]
fn spending_before_the_change_still_counts_against_the_limit_after_it() {
    let fx = setup(TEN_UNITS_7DP);

    spend(&fx, 6 * ONE_UNIT_7DP);
    fx.token_client.set_decimals(&0u32);

    // 5 more would reach 11 units: rejected, so the earlier spend was not forgotten.
    assert!(!try_spend(&fx, 5 * ONE_UNIT_7DP));
    // 4 more lands exactly on the limit.
    assert!(try_spend(&fx, 4 * ONE_UNIT_7DP));
}

#[test]
fn the_policy_never_reads_the_token_decimals() {
    let fx = setup(TEN_UNITS_7DP);
    // Any read of decimals() now panics; the policy must not make one.
    fx.token_client.trap_decimals(&true);

    spend(&fx, ONE_UNIT_7DP);
    assert!(!try_spend(&fx, TEN_UNITS_7DP));
}

#[test]
fn a_token_redeployed_at_a_new_address_is_not_governed_by_the_old_binding() {
    let fx = setup(TEN_UNITS_7DP);

    // The "redeployed" token lives at a different address with different decimals.
    let redeployed = fx.env.register(MockToken, (18u32,));
    assert_ne!(redeployed, fx.token);

    // The policy fails closed on it instead of applying the old base-unit limit
    // to an asset with different precision.
    let rejected = fx
        .policy
        .try_policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, &redeployed, 1))
        .is_err();
    assert!(rejected);

    // The original binding keeps working.
    spend(&fx, ONE_UNIT_7DP);
}
