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
            Some(SignerVal::Policy(
                SignerExpiration(None),
                SignerLimits(None),
            ))
        } else {
            None
        }
    }
}

// ----- Fixtures -----

const DAY: u64 = 60 * 60 * 24;
const TEN_XLM: i128 = 100_000_000; // 10 units in the token's base units (7dp)
/// $10.00 in base units for a 2-decimal-place token (e.g. a fiat-pegged
/// stablecoin quoted in cents) — the low-decimal contrast case for #590.
const LOW_DECIMAL_LIMIT: i128 = 1_000;

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
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx, TEN_XLM + 1),
    );
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
    pa.policy__(
        &wallet,
        &SignerKey::Policy(pa.address.clone()),
        &mk(&token_a, 1),
    );
    assert!(pa
        .try_policy__(
            &wallet,
            &SignerKey::Policy(pa.address.clone()),
            &mk(&token_b, 1)
        )
        .is_err());
    pb.policy__(
        &wallet,
        &SignerKey::Policy(pb.address.clone()),
        &mk(&token_b, 1),
    );
    assert!(pb
        .try_policy__(
            &wallet,
            &SignerKey::Policy(pb.address.clone()),
            &mk(&token_a, 1)
        )
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

// ----- Token decimal places (#590) -----
//
// The policy's `daily_limit`/`Allowance.spent` arithmetic operates purely on
// the raw i128 base-unit amount the `transfer` context carries — it never
// reads or assumes the bound token's `decimals()`. So a token reporting more
// (or fewer) decimal places than XLM's native 7 cannot desync the
// comparison: the limit is simply set, at deploy time, in THAT token's own
// base units, whatever they are. These tests pin that: the cumulative
// window math must not silently truncate or misscale for an usually-decimaled
// token, matched against a lower-decimal token as the contrasting case.

#[test]
fn enforces_limit_correctly_for_a_token_with_more_than_7_decimal_places() {
    // A token with 18 decimals (e.g. an ERC-20-style bridged asset): limit of
    // "10 units" is 10 * 10^18 base units, far larger than any XLM (7dp)
    // amount, and must still be enforced as an exact cumulative cap with no
    // truncation.
    const EIGHTEEN_DP_UNIT: i128 = 1_000_000_000_000_000_000;
    let limit = 10 * EIGHTEEN_DP_UNIT;
    let fx = setup(limit, DAY, false);
    install(&fx);

    // Spending exactly up to the limit succeeds.
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, limit));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")] // NotAllowed
fn rejects_one_base_unit_over_limit_for_a_high_decimal_token() {
    // The highest-precision case: a single base unit (the smallest possible
    // increment for an 18dp token) over the limit must still be rejected —
    // proving the comparison is exact at full precision, not rounded/truncated
    // to something coarser (e.g. as if it assumed 7dp amounts).
    const EIGHTEEN_DP_UNIT: i128 = 1_000_000_000_000_000_000;
    let limit = 10 * EIGHTEEN_DP_UNIT;
    let fx = setup(limit, DAY, false);
    install(&fx);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx, limit + 1));
}

#[test]
fn accumulates_correctly_across_transfers_for_a_high_decimal_token() {
    // Cumulative-window accounting must sum correctly at 18dp scale too, not
    // just in the 7dp fixtures used elsewhere in this file.
    const EIGHTEEN_DP_UNIT: i128 = 1_000_000_000_000_000_000;
    let limit = 10 * EIGHTEEN_DP_UNIT;
    let fx = setup(limit, DAY, false);
    install(&fx);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx, 6 * EIGHTEEN_DP_UNIT),
    );
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx, 4 * EIGHTEEN_DP_UNIT),
    );
}

#[test]
fn enforces_limit_correctly_for_a_token_with_fewer_than_7_decimal_places() {
    // Contrasting case: a low-precision token (e.g. 2 decimals, like a
    // fiat-pegged stablecoin quoted in cents). The limit is set in that
    // token's own base units (cents) and must be enforced exactly, the same
    // as for the high-decimal case above — the policy does not assume 7dp
    // anywhere, so fewer decimals is just as unaffected as more.
    let fx = setup(LOW_DECIMAL_LIMIT, DAY, false);
    install(&fx);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx, LOW_DECIMAL_LIMIT),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_one_base_unit_over_limit_for_a_low_decimal_token() {
    let fx = setup(LOW_DECIMAL_LIMIT, DAY, false);
    install(&fx);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx, LOW_DECIMAL_LIMIT + 1),
    );
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
