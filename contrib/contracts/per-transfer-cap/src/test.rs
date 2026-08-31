#![cfg(test)]

//! Tests for the per-transaction amount cap policy.
//!
//! The policy assumes the wallet is the direct invoker, so `mock_all_auths`
//! stands in for the invoker auth the real smart wallet provides during
//! `__check_auth`. The policy makes no cross-contract calls, so no wallet stub
//! is needed: a generated address is a faithful stand-in for the bound wallet.

extern crate std;

use soroban_sdk::{
    auth::{Context, ContractContext},
    symbol_short,
    testutils::{Address as _, Ledger as _},
    Address, Env, IntoVal, Symbol, Val, Vec,
};

use crate::{classify, Config, Contract, ContractClient, Interaction};

// ----- Fixtures -----

/// 10 XLM expressed in stroops (1 XLM = 10^7 stroops). The cap is always a
/// native-unit quantity; there is no fiat denomination anywhere in this policy.
const TEN_XLM: i128 = 100_000_000;

struct Fixture {
    env: Env,
    policy: ContractClient<'static>,
    wallet: Address,
}

/// Deploy a policy instance bound to a fresh wallet address with the given cap.
fn setup(cap: i128) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let wallet = Address::generate(&env);
    let policy_id = env.register(Contract, (wallet.clone(), cap));
    let policy = ContractClient::new(&env, &policy_id);

    Fixture {
        env,
        policy,
        wallet,
    }
}

/// A single-context SEP-41 transfer of `amount` from the wallet to some other
/// contract, matching what the smart wallet passes to `policy__`.
fn transfer_ctx(env: &Env, wallet: &Address, amount: i128) -> Vec<Context> {
    let dest = Address::generate(env);
    let args: Vec<Val> = (wallet.clone(), dest, amount).into_val(env);
    Vec::from_array(
        env,
        [Context::Contract(ContractContext {
            contract: Address::generate(env), // the token contract
            fn_name: symbol_short!("transfer"),
            args,
        })],
    )
}

fn install(fx: &Fixture) {
    fx.policy.install(&fx.wallet);
}

/// Deploy, install, and return a ready-to-use fixture.
fn installed(cap: i128) -> Fixture {
    let fx = setup(cap);
    install(&fx);
    fx
}

// ----- Constructor / configuration -----

#[test]
fn constructor_stores_cap_in_stroops() {
    let fx = setup(TEN_XLM);
    assert_eq!(
        fx.policy.config(),
        Config {
            wallet: fx.wallet.clone(),
            max_transfer_amount: TEN_XLM,
        }
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")] // InvalidConfig
fn constructor_rejects_zero_cap() {
    setup(0);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_negative_cap() {
    setup(-1);
}

// ----- The four cases the issue requires -----

#[test]
fn allows_transfer_under_cap() {
    let fx = installed(TEN_XLM);
    fx.policy
        .policy__(&fx.wallet, &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM - 1));
}

#[test]
fn allows_transfer_exactly_at_cap() {
    // The boundary is inclusive: a transfer of exactly the cap is permitted.
    let fx = installed(TEN_XLM);
    fx.policy
        .policy__(&fx.wallet, &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")] // NotAllowed
fn rejects_transfer_over_cap() {
    // One stroop over the cap is rejected.
    let fx = installed(TEN_XLM);
    fx.policy
        .policy__(&fx.wallet, &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM + 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_unclassifiable_interaction() {
    // A transfer whose amount argument is absent cannot be classified, so it
    // is rejected rather than allowed through unchecked.
    let fx = installed(TEN_XLM);
    let ctx = Vec::from_array(
        &fx.env,
        [Context::Contract(ContractContext {
            contract: Address::generate(&fx.env),
            fn_name: symbol_short!("transfer"),
            args: (fx.wallet.clone(), Address::generate(&fx.env)).into_val(&fx.env),
        })],
    );
    fx.policy.policy__(&fx.wallet, &ctx);
}

// ----- Per-transfer, NOT cumulative -----

#[test]
fn cap_applies_per_transfer_not_cumulatively() {
    // Three separate at-cap transfers all pass: this rule has no running total
    // and no time window. This is the defining difference from the cumulative
    // spending-limit policy, where the second of these would be rejected.
    let fx = installed(TEN_XLM);
    for _ in 0..3 {
        fx.policy
            .policy__(&fx.wallet, &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM));
    }
}

#[test]
fn cap_is_not_affected_by_elapsed_time() {
    // No window means no reset semantics to get wrong.
    let fx = installed(TEN_XLM);
    fx.policy
        .policy__(&fx.wallet, &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM));
    fx.env
        .ledger()
        .set_timestamp(fx.env.ledger().timestamp() + 60 * 60 * 24 * 30);
    fx.policy
        .policy__(&fx.wallet, &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM));
}

#[test]
fn allows_batch_whose_sum_exceeds_cap_but_each_transfer_does_not() {
    // Two at-cap transfers in one invocation: the SUM (20 XLM) is over the cap
    // but neither individual transfer is, so this rule allows it. Bounding the
    // total is the cumulative policy's job, not this one's.
    let fx = installed(TEN_XLM);
    let dest = Address::generate(&fx.env);
    let token = Address::generate(&fx.env);
    let mk = |amount: i128| {
        Context::Contract(ContractContext {
            contract: token.clone(),
            fn_name: symbol_short!("transfer"),
            args: (fx.wallet.clone(), dest.clone(), amount).into_val(&fx.env),
        })
    };
    let ctx = Vec::from_array(&fx.env, [mk(TEN_XLM), mk(TEN_XLM)]);
    fx.policy.policy__(&fx.wallet, &ctx);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_batch_when_any_single_transfer_is_over_cap() {
    // Every transfer is checked individually, so one oversized entry rejects
    // the whole invocation even when the others are fine.
    let fx = installed(TEN_XLM);
    let dest = Address::generate(&fx.env);
    let token = Address::generate(&fx.env);
    let mk = |amount: i128| {
        Context::Contract(ContractContext {
            contract: token.clone(),
            fn_name: symbol_short!("transfer"),
            args: (fx.wallet.clone(), dest.clone(), amount).into_val(&fx.env),
        })
    };
    let ctx = Vec::from_array(&fx.env, [mk(1), mk(TEN_XLM + 1)]);
    fx.policy.policy__(&fx.wallet, &ctx);
}

#[test]
fn allows_max_i128_transfer_when_cap_is_max_i128() {
    // The largest representable amount against the largest representable cap:
    // the comparison is a plain bounds check, so there is no overflow path.
    let fx = installed(i128::MAX);
    fx.policy
        .policy__(&fx.wallet, &transfer_ctx(&fx.env, &fx.wallet, i128::MAX));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_max_i128_transfer_against_small_cap() {
    let fx = installed(TEN_XLM);
    fx.policy
        .policy__(&fx.wallet, &transfer_ctx(&fx.env, &fx.wallet, i128::MAX));
}

// ----- Deny-by-default -----

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_non_transfer_function() {
    let fx = installed(TEN_XLM);
    let ctx = Vec::from_array(
        &fx.env,
        [Context::Contract(ContractContext {
            contract: Address::generate(&fx.env),
            fn_name: Symbol::new(&fx.env, "approve"),
            args: (fx.wallet.clone(), 1_i128).into_val(&fx.env),
        })],
    );
    fx.policy.policy__(&fx.wallet, &ctx);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_call_targeting_wallet_itself() {
    // A call whose target IS the wallet is its admin surface, never a transfer.
    let fx = installed(TEN_XLM);
    let ctx = Vec::from_array(
        &fx.env,
        [Context::Contract(ContractContext {
            contract: fx.wallet.clone(),
            fn_name: symbol_short!("transfer"),
            args: (
                fx.wallet.clone(),
                Address::generate(&fx.env),
                1_i128,
            )
                .into_val(&fx.env),
        })],
    );
    fx.policy.policy__(&fx.wallet, &ctx);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_zero_amount() {
    let fx = installed(TEN_XLM);
    fx.policy
        .policy__(&fx.wallet, &transfer_ctx(&fx.env, &fx.wallet, 0));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_negative_amount() {
    // A negative amount must never be read as "comfortably under the cap".
    let fx = installed(TEN_XLM);
    fx.policy
        .policy__(&fx.wallet, &transfer_ctx(&fx.env, &fx.wallet, -TEN_XLM));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_non_i128_amount() {
    let fx = installed(TEN_XLM);
    let ctx = Vec::from_array(
        &fx.env,
        [Context::Contract(ContractContext {
            contract: Address::generate(&fx.env),
            fn_name: symbol_short!("transfer"),
            args: (
                fx.wallet.clone(),
                Address::generate(&fx.env),
                symbol_short!("nope"),
            )
                .into_val(&fx.env),
        })],
    );
    fx.policy.policy__(&fx.wallet, &ctx);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_empty_context_list() {
    let fx = installed(TEN_XLM);
    fx.policy.policy__(&fx.wallet, &Vec::new(&fx.env));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_context_list_over_evaluation_limit() {
    // An over-long list is refused outright, so no entry can slip past the cap
    // by sitting beyond the bound we are willing to evaluate.
    let fx = installed(TEN_XLM);
    let dest = Address::generate(&fx.env);
    let token = Address::generate(&fx.env);
    let mut ctx = Vec::new(&fx.env);
    for _ in 0..(crate::MAX_CONTEXT_EVALUATION_LIMIT + 1) {
        ctx.push_back(Context::Contract(ContractContext {
            contract: token.clone(),
            fn_name: symbol_short!("transfer"),
            args: (fx.wallet.clone(), dest.clone(), 1_i128).into_val(&fx.env),
        }));
    }
    fx.policy.policy__(&fx.wallet, &ctx);
}

// ----- Install / binding -----

#[test]
#[should_panic(expected = "Error(Contract, #2)")] // NotInstalled
fn rejects_before_install() {
    let fx = setup(TEN_XLM);
    fx.policy
        .policy__(&fx.wallet, &transfer_ctx(&fx.env, &fx.wallet, 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")] // WrongWallet
fn install_rejects_other_wallet() {
    let fx = setup(TEN_XLM);
    let other = Address::generate(&fx.env);
    fx.policy.install(&other);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn policy_rejects_other_wallet_source() {
    let fx = installed(TEN_XLM);
    let other = Address::generate(&fx.env);
    fx.policy
        .policy__(&other, &transfer_ctx(&fx.env, &other, 1));
}

// ----- Classifier unit tests -----

#[test]
fn classify_recognizes_well_formed_transfer() {
    let env = Env::default();
    let wallet = Address::generate(&env);
    let ctx = transfer_ctx(&env, &wallet, TEN_XLM).get(0).unwrap();
    assert_eq!(
        classify(&env, &wallet, &ctx),
        Interaction::Transfer { amount: TEN_XLM }
    );
}

#[test]
fn classify_reports_unclassifiable_for_other_calls() {
    let env = Env::default();
    let wallet = Address::generate(&env);
    let ctx = Context::Contract(ContractContext {
        contract: Address::generate(&env),
        fn_name: Symbol::new(&env, "approve"),
        args: (1_i128,).into_val(&env),
    });
    assert_eq!(classify(&env, &wallet, &ctx), Interaction::Unclassifiable);
}
