#![cfg(test)]

//! Tests for the token-scoped spending-limit policy.
//!
//! Mirrors the `spending-limit` test suite (the window/limit/deny-by-default
//! invariants are identical) and adds the token-scoping cases that are the whole
//! point of this variant: transfers of the BOUND token count against the budget,
//! and transfers of ANY other token fail the authorization closed (Option A).
//!
//! As in the base policy, we model the wallet with a minimal stub implementing
//! just the `get_signer` view `uninstall` reads, and `mock_all_auths` stands in
//! for the invoker auth the real wallet provides during `__check_auth`.

extern crate std;

use smart_wallet_interface::types::{SignerExpiration, SignerKey, SignerLimits, SignerVal};
use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger as _},
    Address, Env, IntoVal, Symbol, Vec,
};

use crate::{Config, Contract, ContractClient};

// ----- Mock wallet: implements only the view uninstall reads. -----

#[contract]
struct MockWallet;

#[contractimpl]
impl MockWallet {
    pub fn __constructor(env: Env, still_signer: bool) {
        env.storage()
            .instance()
            .set(&symbol_short!("SIGNER"), &still_signer);
    }

    pub fn get_signer(env: Env, _signer_key: SignerKey) -> Option<SignerVal> {
        let still: bool = env
            .storage()
            .instance()
            .get(&symbol_short!("SIGNER"))
            .unwrap_or(false);
        if still {
            Some(SignerVal::Policy(SignerExpiration(None), SignerLimits(None)))
        } else {
            None
        }
    }
}

// ----- Fixtures -----

const DAY: u64 = 60 * 60 * 24;
const TEN_XLM: i128 = 100_000_000; // 10 units in the token's base units (7dp)

struct Fixture {
    env: Env,
    policy: ContractClient<'static>,
    wallet: Address,
    /// The bound token this instance's budget governs.
    token: Address,
}

/// Deploy a policy instance bound to a freshly-registered mock wallet AND a
/// freshly-generated bound token, with the given limit/window.
fn setup(limit: i128, window: u64, wallet_still_signer: bool) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let wallet = env.register(MockWallet, (wallet_still_signer,));
    let token = Address::generate(&env);
    let policy_id = env.register(Contract, (wallet.clone(), token.clone(), limit, window));
    let policy = ContractClient::new(&env, &policy_id);

    Fixture {
        env,
        policy,
        wallet,
        token,
    }
}

/// A single-context transfer of `amount` of the BOUND token, from the wallet to
/// some other destination — matching what the smart wallet passes to `policy__`.
fn transfer_ctx(fx: &Fixture, amount: i128) -> Vec<Context> {
    transfer_ctx_for_token(fx, &fx.token, amount)
}

/// A single-context transfer of `amount` of `token` (any token), for testing
/// token-scoping.
fn transfer_ctx_for_token(fx: &Fixture, token: &Address, amount: i128) -> Vec<Context> {
    let dest = Address::generate(&fx.env);
    let args: Vec<soroban_sdk::Val> = (fx.wallet.clone(), dest.clone(), amount).into_val(&fx.env);
    Vec::from_array(
        &fx.env,
        [Context::Contract(ContractContext {
            contract: token.clone(),
            fn_name: symbol_short!("transfer"),
            args,
        })],
    )
}

fn install(fx: &Fixture) {
    fx.policy.install(&fx.wallet);
}

fn signer_key(fx: &Fixture) -> SignerKey {
    SignerKey::Policy(fx.policy.address.clone())
}

// ----- Constructor validation -----

#[test]
fn constructor_stores_config() {
    let fx = setup(TEN_XLM, DAY, false);
    let config = fx.policy.config();
    assert_eq!(
        config,
        Config {
            wallet: fx.wallet.clone(),
            token: fx.token.clone(),
            daily_limit: TEN_XLM,
            window_seconds: DAY,
        }
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")] // InvalidConfig
fn constructor_rejects_zero_limit() {
    setup(0, DAY, false);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_negative_limit() {
    setup(-1, DAY, false);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_zero_window() {
    setup(TEN_XLM, 0, false);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_window_over_max() {
    setup(TEN_XLM, DAY * 366, false);
}

// ----- install / wrong-wallet binding -----

#[test]
fn install_marks_installed() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")] // WrongWallet
fn install_rejects_other_wallet() {
    let fx = setup(TEN_XLM, DAY, false);
    let other = Address::generate(&fx.env);
    fx.policy.install(&other);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn policy_rejects_other_wallet_source() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    let other = Address::generate(&fx.env);
    // Even a bound-token transfer from a different source wallet is rejected.
    let ctx = transfer_ctx_for_token(&fx, &fx.token.clone(), 1);
    fx.policy.policy__(&other, &signer_key(&fx), &ctx);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")] // NotInstalled
fn policy_rejects_before_install() {
    let fx = setup(TEN_XLM, DAY, false);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, 1));
}

// ----- Cumulative window enforcement (bound token) -----

#[test]
fn allows_spend_up_to_limit() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, TEN_XLM));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")] // NotAllowed
fn rejects_single_spend_over_limit() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, TEN_XLM + 1));
}

#[test]
fn accumulates_across_transfers_within_window() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, 60_000_000));
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, 40_000_000));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_cumulative_over_limit() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    // 6 ok, then 5 pushes cumulative to 11 > 10: rejected. The case a
    // per-transfer cap would MISS.
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, 60_000_000));
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, 50_000_000));
}

#[test]
fn window_resets_after_elapse() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, TEN_XLM));
    fx.env
        .ledger()
        .set_timestamp(fx.env.ledger().timestamp() + DAY);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, TEN_XLM));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn window_does_not_reset_before_elapse() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, TEN_XLM));
    fx.env
        .ledger()
        .set_timestamp(fx.env.ledger().timestamp() + DAY - 1);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, 1));
}

#[test]
fn respects_custom_limit_and_window() {
    let limit = 250_000_000;
    let window = 3600;
    let fx = setup(limit, window, false);
    install(&fx);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, limit));
    let res = fx
        .policy
        .try_policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, 1));
    assert!(res.is_err());
    fx.env
        .ledger()
        .set_timestamp(fx.env.ledger().timestamp() + window);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, limit));
}

// ----- Token-scoping (the point of this variant) -----

#[test]
#[should_panic(expected = "Error(Contract, #1)")] // NotAllowed
fn rejects_transfer_of_other_token() {
    // A transfer of a DIFFERENT token than the bound one is not this policy's to
    // authorize: fail closed (Option A).
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    let other_token = Address::generate(&fx.env);
    let ctx = transfer_ctx_for_token(&fx, &other_token, 1);
    fx.policy.policy__(&fx.wallet, &signer_key(&fx), &ctx);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_mixed_bound_and_other_token_in_one_invocation() {
    // Even when the bound-token portion is within budget, a single other-token
    // transfer in the same invocation rejects the WHOLE authorization — the
    // policy never partially covers a token it does not govern.
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    let other_token = Address::generate(&fx.env);
    let dest = Address::generate(&fx.env);
    let bound = Context::Contract(ContractContext {
        contract: fx.token.clone(),
        fn_name: symbol_short!("transfer"),
        args: (fx.wallet.clone(), dest.clone(), 1_i128).into_val(&fx.env),
    });
    let other = Context::Contract(ContractContext {
        contract: other_token,
        fn_name: symbol_short!("transfer"),
        args: (fx.wallet.clone(), dest.clone(), 1_i128).into_val(&fx.env),
    });
    let ctx = Vec::from_array(&fx.env, [bound, other]);
    fx.policy.policy__(&fx.wallet, &signer_key(&fx), &ctx);
}

#[test]
fn other_token_transfers_do_not_consume_bound_budget() {
    // A rejected other-token attempt commits NO spend, so the full bound-token
    // budget remains available afterward. (try_policy__ so the rejection is
    // recoverable and we can keep asserting.)
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    let other_token = Address::generate(&fx.env);
    let res = fx.policy.try_policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx_for_token(&fx, &other_token, TEN_XLM),
    );
    assert!(res.is_err());
    // Full bound-token cap still spendable.
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, TEN_XLM));
}

#[test]
fn two_instances_bind_distinct_tokens() {
    // Two instances for the same wallet but different tokens each enforce ONLY
    // their own token — proving scoping is per-instance, the multi-token pattern.
    let env = Env::default();
    env.mock_all_auths();
    let wallet = env.register(MockWallet, (false,));
    let token_a = Address::generate(&env);
    let token_b = Address::generate(&env);

    let pa = ContractClient::new(
        &env,
        &env.register(Contract, (wallet.clone(), token_a.clone(), TEN_XLM, DAY)),
    );
    let pb = ContractClient::new(
        &env,
        &env.register(Contract, (wallet.clone(), token_b.clone(), TEN_XLM, DAY)),
    );
    pa.install(&wallet);
    pb.install(&wallet);

    let dest = Address::generate(&env);
    let mk = |token: &Address, amount: i128| {
        Vec::from_array(
            &env,
            [Context::Contract(ContractContext {
                contract: token.clone(),
                fn_name: symbol_short!("transfer"),
                args: (wallet.clone(), dest.clone(), amount).into_val(&env),
            })],
        )
    };
    // policy A authorizes token_a, rejects token_b; policy B the reverse.
    pa.policy__(&wallet, &SignerKey::Policy(pa.address.clone()), &mk(&token_a, 1));
    assert!(pa
        .try_policy__(&wallet, &SignerKey::Policy(pa.address.clone()), &mk(&token_b, 1))
        .is_err());
    pb.policy__(&wallet, &SignerKey::Policy(pb.address.clone()), &mk(&token_b, 1));
    assert!(pb
        .try_policy__(&wallet, &SignerKey::Policy(pb.address.clone()), &mk(&token_a, 1))
        .is_err());
}

// ----- Deny-by-default -----

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_non_transfer_fn() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    // `approve` on the BOUND token: still rejected — only `transfer` passes.
    let ctx = Vec::from_array(
        &fx.env,
        [Context::Contract(ContractContext {
            contract: fx.token.clone(),
            fn_name: Symbol::new(&fx.env, "approve"),
            args: (fx.wallet.clone(), 1_i128).into_val(&fx.env),
        })],
    );
    fx.policy.policy__(&fx.wallet, &signer_key(&fx), &ctx);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_transfer_targeting_wallet_itself() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    let ctx = Vec::from_array(
        &fx.env,
        [Context::Contract(ContractContext {
            contract: fx.wallet.clone(), // == source: forbidden (admin surface)
            fn_name: symbol_short!("transfer"),
            args: (fx.wallet.clone(), Address::generate(&fx.env), 1_i128).into_val(&fx.env),
        })],
    );
    fx.policy.policy__(&fx.wallet, &signer_key(&fx), &ctx);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_zero_amount() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, 0));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_negative_amount() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, -5));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_missing_amount_arg() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    // A bound-token transfer with too few args (no amount at index 2).
    let ctx = Vec::from_array(
        &fx.env,
        [Context::Contract(ContractContext {
            contract: fx.token.clone(),
            fn_name: symbol_short!("transfer"),
            args: (fx.wallet.clone(), Address::generate(&fx.env)).into_val(&fx.env),
        })],
    );
    fx.policy.policy__(&fx.wallet, &signer_key(&fx), &ctx);
}

#[test]
fn allows_batch_of_transfers_within_limit() {
    // Two BOUND-token transfer contexts summing to the cap: allowed.
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    let dest = Address::generate(&fx.env);
    let mk = |amount: i128| {
        Context::Contract(ContractContext {
            contract: fx.token.clone(),
            fn_name: symbol_short!("transfer"),
            args: (fx.wallet.clone(), dest.clone(), amount).into_val(&fx.env),
        })
    };
    let ctx = Vec::from_array(&fx.env, [mk(40_000_000), mk(60_000_000)]);
    fx.policy.policy__(&fx.wallet, &signer_key(&fx), &ctx);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_batch_of_transfers_over_limit() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    let dest = Address::generate(&fx.env);
    let mk = |amount: i128| {
        Context::Contract(ContractContext {
            contract: fx.token.clone(),
            fn_name: symbol_short!("transfer"),
            args: (fx.wallet.clone(), dest.clone(), amount).into_val(&fx.env),
        })
    };
    let ctx = Vec::from_array(&fx.env, [mk(60_000_000), mk(60_000_000)]);
    fx.policy.policy__(&fx.wallet, &signer_key(&fx), &ctx);
}

// ----- uninstall self-clean -----

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // StillInstalled
fn uninstall_refuses_while_still_signer() {
    let fx = setup(TEN_XLM, DAY, true);
    install(&fx);
    fx.policy.uninstall(&fx.wallet);
}

#[test]
fn uninstall_clears_state_once_removed() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, TEN_XLM));
    fx.policy.uninstall(&fx.wallet);
    let res = fx
        .policy
        .try_policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, 1));
    assert!(res.is_err());
}

// ----- Non-standard token decimal scales (#590) -----

#[test]
fn enforces_exact_base_unit_allowance_for_18_decimal_token() {
    // 18-decimal ERC-20-style bridged token (11 more decimal places than XLM's
    // native 7): 1,000 tokens = 1_000 * 10^18 base units, which exceeds u64::MAX
    // and exercises full i128 base-unit precision without truncation.
    const ONE_TOKEN_18DP: i128 = 1_000_000_000_000_000_000; // 10^18
    const LIMIT_18DP: i128 = 1_000 * ONE_TOKEN_18DP; // 1,000 tokens (10^21 > u64::MAX)

    let fx = setup(LIMIT_18DP, DAY, false);
    install(&fx);

    // 600.5 tokens + 399.5 tokens = 1,000.0 tokens (exact cap in 18dp base units)
    let first_leg = 600 * ONE_TOKEN_18DP + (ONE_TOKEN_18DP / 2);
    let second_leg = 399 * ONE_TOKEN_18DP + (ONE_TOKEN_18DP / 2);
    assert_eq!(first_leg + second_leg, LIMIT_18DP);

    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, first_leg));
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, second_leg));

    // Even 1 wei-equivalent (10^-18 token) above the cumulative cap is rejected.
    let over_by_one_base_unit = fx
        .policy
        .try_policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, 1));
    assert!(over_by_one_base_unit.is_err());
}

#[test]
fn enforces_exact_base_unit_allowance_for_fewer_than_7_decimals_token() {
    // Contrasting case with fewer than 7 decimals (e.g. 6-decimal USDC where
    // 1 token = 1_000_000 base units, 10x smaller than 7-decimal stroops).
    // Verify the contract does not implicitly assume 10^7 scaling.
    const ONE_TOKEN_6DP: i128 = 1_000_000; // 10^6
    const TEN_UNITS_6DP: i128 = 10 * ONE_TOKEN_6DP; // 10_000_000 base units

    let fx = setup(TEN_UNITS_6DP, DAY, false);
    install(&fx);

    // If the contract mistakenly scaled by 10^7 (TEN_XLM = 100_000_000), a
    // 10_000_001 transfer would wrongly pass. Here 10_000_000 is the exact cap.
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx, 6 * ONE_TOKEN_6DP),
    );
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx, 4 * ONE_TOKEN_6DP),
    );

    let over_by_one_micro_unit = fx
        .policy
        .try_policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, 1));
    assert!(over_by_one_micro_unit.is_err());
}

