#![cfg(test)]

//! Tests for the configurable spending-limit policy.
//!
//! The policy makes cross-contract calls into the wallet it is bound to
//! (`uninstall` reads `get_signer`), and its auth model assumes the wallet is
//! the direct invoker. We model the wallet with a minimal stub contract that
//! implements just the `get_signer` view the policy consults, and use
//! `mock_all_auths` to stand in for the invoker auth the real wallet provides
//! during `__check_auth`. This exercises every branch of the policy's own
//! logic without pulling in the full smart-wallet wasm.

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

/// When `HAS_SIGNER` is true the stub reports the policy is still a signer, so
/// `uninstall` must refuse. Toggled per-test via constructor arg.
#[contract]
struct MockWallet;

#[contractimpl]
impl MockWallet {
    pub fn __constructor(env: Env, still_signer: bool) {
        env.storage()
            .instance()
            .set(&symbol_short!("SIGNER"), &still_signer);
    }

    /// Mirrors SmartWalletInterface::get_signer closely enough for uninstall:
    /// returns Some(..) while the policy is "still a signer", else None.
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
const TEN_XLM: i128 = 100_000_000; // 10 XLM in stroops

struct Fixture {
    env: Env,
    policy: ContractClient<'static>,
    wallet: Address,
}

/// Deploy a policy instance bound to a freshly-registered mock wallet, with
/// the given limit/window. `wallet_still_signer` controls what the mock wallet
/// reports to `uninstall`.
fn setup(limit: i128, window: u64, wallet_still_signer: bool) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let wallet = env.register(MockWallet, (wallet_still_signer,));
    let policy_id = env.register(Contract, (wallet.clone(), limit, window));
    let policy = ContractClient::new(&env, &policy_id);

    Fixture { env, policy, wallet }
}

/// A single-context transfer of `amount` from the wallet to some other
/// contract, matching what the smart wallet passes to `policy__`.
fn transfer_ctx(env: &Env, wallet: &Address, amount: i128) -> Vec<Context> {
    let dest = Address::generate(env); // a contract that is not the wallet
    let args: Vec<soroban_sdk::Val> =
        (wallet.clone(), dest.clone(), amount).into_val(env);
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
    // A within-limit transfer now passes (proves installed marker is set).
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx.env, &fx.wallet, 1));
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
    fx.policy
        .policy__(&other, &signer_key(&fx), &transfer_ctx(&fx.env, &other, 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")] // NotInstalled
fn policy_rejects_before_install() {
    let fx = setup(TEN_XLM, DAY, false);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx.env, &fx.wallet, 1));
}

// ----- Cumulative window enforcement -----

#[test]
fn allows_spend_up_to_limit() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    // Exactly the cap in one shot.
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")] // NotAllowed
fn rejects_single_spend_over_limit() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM + 1));
}

#[test]
fn accumulates_across_transfers_within_window() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    // 6 + 4 == 10 XLM, both inside the same window: both pass.
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, 60_000_000),
    );
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, 40_000_000),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_cumulative_over_limit() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    // 6 XLM ok, then 5 XLM pushes cumulative to 11 > 10: rejected. This is
    // the security-critical case a per-transfer cap would MISS.
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, 60_000_000),
    );
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, 50_000_000),
    );
}

#[test]
fn window_resets_after_elapse() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    // Spend the full cap.
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM));
    // Advance past the window; a fresh full cap is available again.
    fx.env.ledger().set_timestamp(fx.env.ledger().timestamp() + DAY);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn window_does_not_reset_before_elapse() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM));
    // Just short of the window boundary: still the same window, no headroom.
    fx.env
        .ledger()
        .set_timestamp(fx.env.ledger().timestamp() + DAY - 1);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx.env, &fx.wallet, 1));
}

#[test]
fn respects_custom_limit_and_window() {
    // 25 XLM over 1 hour — proves config actually drives enforcement.
    let limit = 250_000_000;
    let window = 3600;
    let fx = setup(limit, window, false);
    install(&fx);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx.env, &fx.wallet, limit));
    // One more stroop in the same window is over-cap.
    let res = fx.policy.try_policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, 1),
    );
    assert!(res.is_err());
    // After the 1h window, full cap available again.
    fx.env
        .ledger()
        .set_timestamp(fx.env.ledger().timestamp() + window);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx.env, &fx.wallet, limit));
}

// ----- Deny-by-default -----

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_non_transfer_fn() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    let ctx = Vec::from_array(
        &fx.env,
        [Context::Contract(ContractContext {
            contract: Address::generate(&fx.env),
            fn_name: Symbol::new(&fx.env, "approve"),
            args: (fx.wallet.clone(), 1_i128).into_val(&fx.env),
        })],
    );
    fx.policy.policy__(&fx.wallet, &signer_key(&fx), &ctx);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_transfer_targeting_wallet_itself() {
    // A transfer whose target contract IS the wallet (its admin surface).
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    let ctx = Vec::from_array(
        &fx.env,
        [Context::Contract(ContractContext {
            contract: fx.wallet.clone(), // == source: forbidden
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
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx.env, &fx.wallet, 0));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_negative_amount() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx.env, &fx.wallet, -5));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_missing_amount_arg() {
    // A transfer with too few args (no amount at index 2): fail closed.
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    let ctx = Vec::from_array(
        &fx.env,
        [Context::Contract(ContractContext {
            contract: Address::generate(&fx.env),
            fn_name: symbol_short!("transfer"),
            args: (fx.wallet.clone(), Address::generate(&fx.env)).into_val(&fx.env),
        })],
    );
    fx.policy.policy__(&fx.wallet, &signer_key(&fx), &ctx);
}

#[test]
fn allows_batch_of_transfers_within_limit() {
    // Two transfer contexts in one invocation summing to the cap: allowed.
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    let dest = Address::generate(&fx.env);
    let token = Address::generate(&fx.env);
    let mk = |amount: i128| {
        Context::Contract(ContractContext {
            contract: token.clone(),
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
    let token = Address::generate(&fx.env);
    let mk = |amount: i128| {
        Context::Contract(ContractContext {
            contract: token.clone(),
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
    // Mock wallet reports the policy is still a signer.
    let fx = setup(TEN_XLM, DAY, true);
    install(&fx);
    fx.policy.uninstall(&fx.wallet);
}

#[test]
fn uninstall_clears_state_once_removed() {
    // Mock wallet reports the policy is no longer a signer.
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    // Bank some spend so there is per-wallet state to clear.
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM));
    fx.policy.uninstall(&fx.wallet);
    // After uninstall the installed marker is gone: policy__ now NotInstalled.
    let res = fx.policy.try_policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, 1),
    );
    assert!(res.is_err());
}
