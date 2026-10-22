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
    Address, Env, IntoVal, Map, Symbol, Vec,
};

use crate::{Config, Contract, ContractClient, PolicyError, SafetyRules, MAX_CONTEXTS};

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
    setup_with_rules(limit, window, wallet_still_signer, no_rules)
}

/// Deploy with explicit safety rules (built from the env so the rule tables
/// can hold freshly generated addresses). The closure receives the env and the
/// wallet so rules can reference other addresses generated in the same env.
fn setup_with_rules(
    limit: i128,
    window: u64,
    wallet_still_signer: bool,
    rules: impl FnOnce(&Env) -> SafetyRules,
) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let wallet = env.register(MockWallet, (wallet_still_signer,));
    let rules = rules(&env);
    let policy_id = env.register(Contract, (wallet.clone(), limit, window, rules));
    let policy = ContractClient::new(&env, &policy_id);

    Fixture {
        env,
        policy,
        wallet,
    }
}

/// The original spending-limit behavior: no per-token ceilings, any token.
fn no_rules(env: &Env) -> SafetyRules {
    SafetyRules {
        max_single_transfer: Map::new(env),
        allowed_tokens: None,
    }
}

/// A transfer of `amount` of `token` from the wallet to a fresh destination.
fn token_transfer_ctx(env: &Env, wallet: &Address, token: &Address, amount: i128) -> Vec<Context> {
    let dest = Address::generate(env);
    let args: Vec<soroban_sdk::Val> = (wallet.clone(), dest, amount).into_val(env);
    Vec::from_array(
        env,
        [Context::Contract(ContractContext {
            contract: token.clone(),
            fn_name: symbol_short!("transfer"),
            args,
        })],
    )
}

/// A single-context transfer of `amount` from the wallet to some other
/// contract, matching what the smart wallet passes to `policy__`.
fn transfer_ctx(env: &Env, wallet: &Address, amount: i128) -> Vec<Context> {
    let dest = Address::generate(env); // a contract that is not the wallet
    let args: Vec<soroban_sdk::Val> = (wallet.clone(), dest.clone(), amount).into_val(env);
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
            rules: no_rules(&fx.env),
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
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, 1),
    );
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
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, 1),
    );
}

// ----- Cumulative window enforcement -----

#[test]
fn allows_spend_up_to_limit() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    // Exactly the cap in one shot.
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")] // NotAllowed
fn rejects_single_spend_over_limit() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM + 1),
    );
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
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM),
    );
    // Advance past the window; a fresh full cap is available again.
    fx.env
        .ledger()
        .set_timestamp(fx.env.ledger().timestamp() + DAY);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn window_does_not_reset_before_elapse() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM),
    );
    // Just short of the window boundary: still the same window, no headroom.
    fx.env
        .ledger()
        .set_timestamp(fx.env.ledger().timestamp() + DAY - 1);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, 1),
    );
}

// DOCUMENTED BOUNDARY BEHAVIOR (security-audit.md M3): the window is FIXED
// (tumbling), not sliding, so up to 2 * daily_limit can move across a boundary.
// These two tests PIN that property in both directions: if someone changes the
// reset logic (e.g. to a sliding window), the first test starts failing —
// telling them they changed the documented contract. The module doc + the UI
// copy promise exactly this behavior; keep them in sync with these tests.
#[test]
fn boundary_allows_up_to_two_times_limit() {
    // window_start is anchored at the FIRST spend. Anchor it with a tiny spend
    // at t=0, then spend the REST of the cap near the very end of that window,
    // then cross the boundary and spend a FRESH full cap — the two large spends
    // land within ~1 second of each other yet total ~2 * TEN_XLM.
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    // t=0: anchor window_start=0 with a 1-stroop spend.
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, 1),
    );
    // Near the end of window 0: spend the rest of the cap (10 XLM - 1 stroop).
    fx.env
        .ledger()
        .set_timestamp(fx.env.ledger().timestamp() + DAY - 1);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM - 1),
    );
    // +1s crosses into window 1 (elapsed == DAY → reset): a fresh full cap
    // passes. ~2 * TEN_XLM moved across the boundary in ~1 second.
    fx.env
        .ledger()
        .set_timestamp(fx.env.ledger().timestamp() + 1);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn boundary_does_not_allow_more_than_two_times_limit() {
    // The 2x is a HARD ceiling per boundary, not unbounded: after the fresh
    // window's full cap is spent, one more stroop in that same new window is
    // rejected. Proves the leak is exactly 2x, not "reset lets anything through".
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, 1),
    );
    fx.env
        .ledger()
        .set_timestamp(fx.env.ledger().timestamp() + DAY - 1);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM - 1),
    );
    fx.env
        .ledger()
        .set_timestamp(fx.env.ledger().timestamp() + 1);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM),
    );
    // Third spend, still inside the new window → over the fresh cap → rejected.
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, 1),
    );
}

// DOCUMENTED BOUNDARY BEHAVIOR, exact instant (security-audit.md M3 / #589):
// the reset condition is `now - window_start >= window_seconds`, so the
// ledger-close exactly `window_seconds` after `window_start` is the FIRST
// instant counted in the NEW window, not the last instant of the old one.
// These three tests pin that exact instant against its immediate neighbors
// (one ledger before, and the instant itself), so the off-by-one is explicit
// and deliberate rather than incidental.
#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn one_ledger_before_window_reset_is_still_old_window() {
    // window_start anchored at t=0. At t = DAY - 1 (one ledger before the
    // reset instant), `now - window_start == DAY - 1 < window_seconds`: still
    // the OLD window, so having already spent the full cap leaves no headroom.
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM),
    );
    fx.env
        .ledger()
        .set_timestamp(fx.env.ledger().timestamp() + DAY - 1);
    // Fails: still inside the window that already spent the full cap.
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, 1),
    );
}

#[test]
fn exact_reset_instant_counts_as_new_window() {
    // window_start anchored at t=0. At t = DAY EXACTLY,
    // `now - window_start == DAY >= window_seconds`: the reset condition is
    // satisfied at this exact instant, so a fresh full cap is available even
    // though only `window_seconds` (not more) has elapsed. This is the
    // deliberate choice this test pins: ">=" resets ON the boundary instant,
    // not strictly after it.
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM),
    );
    fx.env
        .ledger()
        .set_timestamp(fx.env.ledger().timestamp() + DAY);
    // Passes: the exact reset instant already belongs to the new window.
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn one_ledger_after_window_reset_is_new_window_with_its_own_cap() {
    // window_start anchored at t=0. At t = DAY + 1 (one ledger after the reset
    // instant), we're one ledger INTO the new window: still a fresh cap, but
    // that fresh cap is itself a hard ceiling — spending it twice in the same
    // new window still rejects. Contrasts with the exact-instant test above:
    // the new window's cap is fresh exactly once, not unbounded.
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM),
    );
    fx.env
        .ledger()
        .set_timestamp(fx.env.ledger().timestamp() + DAY + 1);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM),
    );
    // Second spend in the same (new) window, over its fresh cap → rejected.
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, 1),
    );
}

#[test]
fn respects_custom_limit_and_window() {
    // 25 XLM over 1 hour — proves config actually drives enforcement.
    let limit = 250_000_000;
    let window = 3600;
    let fx = setup(limit, window, false);
    install(&fx);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, limit),
    );
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
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, limit),
    );
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
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, 0),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_negative_amount() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, -5),
    );
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
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM),
    );
    fx.policy.uninstall(&fx.wallet);
    // After uninstall the installed marker is gone: policy__ now NotInstalled.
    let res = fx.policy.try_policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, 1),
    );
    assert!(res.is_err());
}

// ============================================================================
// Safety rules (#399): on-chain spending controls for the recognized transfer
// pattern. Every amount is in the token's base units — there is no USD here.
// ============================================================================

/// The `try_policy__` error shape for a specific contract error code.
#[allow(clippy::type_complexity)]
fn contract_err(
    e: PolicyError,
) -> Result<
    Result<(), soroban_sdk::ConversionError>,
    Result<soroban_sdk::Error, soroban_sdk::InvokeError>,
> {
    Err(Ok(soroban_sdk::Error::from_contract_error(e as u32)))
}

/// Deploy a policy whose rules reference addresses generated in the same env.
/// Returns the fixture plus the addresses the rules were built from.
fn setup_ruled(
    build: impl FnOnce(&Env, &Address) -> (SafetyRules, std::vec::Vec<Address>),
) -> (Fixture, std::vec::Vec<Address>) {
    let env = Env::default();
    env.mock_all_auths();
    let wallet = env.register(MockWallet, (false,));
    let (rules, addrs) = build(&env, &wallet);
    let policy_id = env.register(Contract, (wallet.clone(), TEN_XLM, DAY, rules));
    let policy = ContractClient::new(&env, &policy_id);
    (
        Fixture {
            env,
            policy,
            wallet,
        },
        addrs,
    )
}

// ----- Rule config validation -----

#[test]
fn constructor_stores_rules() {
    let (fx, _) = setup_ruled(|env, _| {
        let token = Address::generate(env);
        let mut caps = Map::new(env);
        caps.set(token.clone(), 5_000_000_i128);
        (
            SafetyRules {
                max_single_transfer: caps,
                allowed_tokens: Some(Vec::from_array(env, [token.clone()])),
            },
            std::vec![token],
        )
    });
    let config = fx.policy.config();
    assert_eq!(config.rules.max_single_transfer.len(), 1);
    assert_eq!(config.rules.allowed_tokens.map(|v| v.len()), Some(1));
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")] // InvalidConfig
fn constructor_rejects_zero_single_transfer_cap() {
    setup_with_rules(TEN_XLM, DAY, false, |env| {
        let mut caps = Map::new(env);
        caps.set(Address::generate(env), 0_i128);
        SafetyRules {
            max_single_transfer: caps,
            allowed_tokens: None,
        }
    });
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_empty_allowlist() {
    // An empty allowlist would authorize nothing — a misconfiguration, not a
    // policy. Refuse at deploy rather than ship a silently dead instance.
    setup_with_rules(TEN_XLM, DAY, false, |env| SafetyRules {
        max_single_transfer: Map::new(env),
        allowed_tokens: Some(Vec::new(env)),
    });
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_oversized_allowlist() {
    setup_with_rules(TEN_XLM, DAY, false, |env| {
        let mut tokens = Vec::new(env);
        for _ in 0..(crate::MAX_RULE_ENTRIES + 1) {
            tokens.push_back(Address::generate(env));
        }
        SafetyRules {
            max_single_transfer: Map::new(env),
            allowed_tokens: Some(tokens),
        }
    });
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_oversized_cap_table() {
    setup_with_rules(TEN_XLM, DAY, false, |env| {
        let mut caps = Map::new(env);
        for _ in 0..(crate::MAX_RULE_ENTRIES + 1) {
            caps.set(Address::generate(env), 1_i128);
        }
        SafetyRules {
            max_single_transfer: caps,
            allowed_tokens: None,
        }
    });
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_wallet_as_allowlisted_token() {
    // The wallet's own address can never be a token this policy authorizes
    // (its admin surface is always denied), so listing it is a config error.
    let env = Env::default();
    env.mock_all_auths();
    let wallet = env.register(MockWallet, (false,));
    let rules = SafetyRules {
        max_single_transfer: Map::new(&env),
        allowed_tokens: Some(Vec::from_array(&env, [wallet.clone()])),
    };
    env.register(Contract, (wallet, TEN_XLM, DAY, rules));
}

// ----- Rule A: per-token maximum single transfer -----

#[test]
fn single_transfer_cap_leaves_uncapped_tokens_to_the_window() {
    let (fx, _) = setup_ruled(|env, _| {
        let mut caps = Map::new(env);
        caps.set(Address::generate(env), 1_i128); // some other token's cap
        (
            SafetyRules {
                max_single_transfer: caps,
                allowed_tokens: None,
            },
            std::vec![],
        )
    });
    install(&fx);
    // Uncapped token: only the cumulative window applies.
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM),
    );
}

#[test]
fn single_transfer_cap_accepts_at_cap_and_rejects_over_cap() {
    // 2 XLM per transfer on `token`, 10 XLM cumulative window.
    let (fx, addrs) = setup_ruled(|env, _| {
        let token = Address::generate(env);
        let mut caps = Map::new(env);
        caps.set(token.clone(), 20_000_000_i128);
        (
            SafetyRules {
                max_single_transfer: caps,
                allowed_tokens: None,
            },
            std::vec![token],
        )
    });
    let token = &addrs[0];
    install(&fx);
    // Exactly the cap: accepted.
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &token_transfer_ctx(&fx.env, &fx.wallet, token, 20_000_000),
    );
    // One stroop over the per-transfer cap, well under the window: rejected
    // with the rule-specific error.
    let res = fx.policy.try_policy__(
        &fx.wallet,
        &signer_key(&fx),
        &token_transfer_ctx(&fx.env, &fx.wallet, token, 20_000_001),
    );
    assert_eq!(res, contract_err(PolicyError::SingleTransferExceeded));
}

#[test]
fn single_transfer_cap_is_per_token_not_global() {
    // A cap on token A must not constrain token B (no oracle: units differ).
    let (fx, addrs) = setup_ruled(|env, _| {
        let token_a = Address::generate(env);
        let token_b = Address::generate(env);
        let mut caps = Map::new(env);
        caps.set(token_a.clone(), 1_000_000_i128);
        (
            SafetyRules {
                max_single_transfer: caps,
                allowed_tokens: None,
            },
            std::vec![token_a, token_b],
        )
    });
    install(&fx);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &token_transfer_ctx(&fx.env, &fx.wallet, &addrs[1], 5_000_000),
    );
    let res = fx.policy.try_policy__(
        &fx.wallet,
        &signer_key(&fx),
        &token_transfer_ctx(&fx.env, &fx.wallet, &addrs[0], 5_000_000),
    );
    assert_eq!(res, contract_err(PolicyError::SingleTransferExceeded));
}

#[test]
fn single_transfer_cap_applies_per_context_within_a_batch() {
    // Two contexts each under the per-transfer cap pass the per-context rule;
    // one context over it fails the whole batch.
    let (fx, addrs) = setup_ruled(|env, _| {
        let token = Address::generate(env);
        let mut caps = Map::new(env);
        caps.set(token.clone(), 60_000_000_i128);
        (
            SafetyRules {
                max_single_transfer: caps,
                allowed_tokens: None,
            },
            std::vec![token],
        )
    });
    let token = addrs[0].clone();
    install(&fx);
    let dest = Address::generate(&fx.env);
    let mk = |amount: i128| {
        Context::Contract(ContractContext {
            contract: token.clone(),
            fn_name: symbol_short!("transfer"),
            args: (fx.wallet.clone(), dest.clone(), amount).into_val(&fx.env),
        })
    };
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &Vec::from_array(&fx.env, [mk(50_000_000), mk(50_000_000)]),
    );
    let res = fx.policy.try_policy__(
        &fx.wallet,
        &signer_key(&fx),
        &Vec::from_array(&fx.env, [mk(1), mk(60_000_001)]),
    );
    assert_eq!(res, contract_err(PolicyError::SingleTransferExceeded));
}

// ----- Rule B: token allowlist -----

#[test]
fn allowlist_accepts_listed_token_and_rejects_unlisted() {
    let (fx, addrs) = setup_ruled(|env, _| {
        let allowed = Address::generate(env);
        let other = Address::generate(env);
        (
            SafetyRules {
                max_single_transfer: Map::new(env),
                allowed_tokens: Some(Vec::from_array(env, [allowed.clone()])),
            },
            std::vec![allowed, other],
        )
    });
    install(&fx);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &token_transfer_ctx(&fx.env, &fx.wallet, &addrs[0], 1),
    );
    let res = fx.policy.try_policy__(
        &fx.wallet,
        &signer_key(&fx),
        &token_transfer_ctx(&fx.env, &fx.wallet, &addrs[1], 1),
    );
    assert_eq!(res, contract_err(PolicyError::TokenNotAllowed));
}

#[test]
fn allowlist_one_unlisted_context_fails_the_whole_batch() {
    let (fx, addrs) = setup_ruled(|env, _| {
        let allowed = Address::generate(env);
        let other = Address::generate(env);
        (
            SafetyRules {
                max_single_transfer: Map::new(env),
                allowed_tokens: Some(Vec::from_array(env, [allowed.clone()])),
            },
            std::vec![allowed, other],
        )
    });
    install(&fx);
    let dest = Address::generate(&fx.env);
    let mk = |token: &Address| {
        Context::Contract(ContractContext {
            contract: token.clone(),
            fn_name: symbol_short!("transfer"),
            args: (fx.wallet.clone(), dest.clone(), 1_i128).into_val(&fx.env),
        })
    };
    let res = fx.policy.try_policy__(
        &fx.wallet,
        &signer_key(&fx),
        &Vec::from_array(&fx.env, [mk(&addrs[0]), mk(&addrs[1])]),
    );
    assert_eq!(res, contract_err(PolicyError::TokenNotAllowed));
}

#[test]
fn rules_compose_with_the_cumulative_window() {
    // Allowlisted token, per-transfer cap 6 XLM, window 10 XLM: two 6 XLM
    // transfers pass the rule individually but the second breaks the window.
    let (fx, addrs) = setup_ruled(|env, _| {
        let token = Address::generate(env);
        let mut caps = Map::new(env);
        caps.set(token.clone(), 60_000_000_i128);
        (
            SafetyRules {
                max_single_transfer: caps,
                allowed_tokens: Some(Vec::from_array(env, [token.clone()])),
            },
            std::vec![token],
        )
    });
    install(&fx);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &token_transfer_ctx(&fx.env, &fx.wallet, &addrs[0], 60_000_000),
    );
    let res = fx.policy.try_policy__(
        &fx.wallet,
        &signer_key(&fx),
        &token_transfer_ctx(&fx.env, &fx.wallet, &addrs[0], 60_000_000),
    );
    assert_eq!(res, contract_err(PolicyError::NotAllowed));
}

// ----- Explicit auth_contexts parsing -----

#[test]
fn rejects_mismatched_context_from_is_not_the_wallet() {
    // A transfer context whose `from` is some other account is not an
    // authorization this policy governs — even though the token, function
    // and amount all look fine. A policy that ignored `from` would be fake.
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    let stranger = Address::generate(&fx.env);
    let ctx = Vec::from_array(
        &fx.env,
        [Context::Contract(ContractContext {
            contract: Address::generate(&fx.env),
            fn_name: symbol_short!("transfer"),
            args: (stranger, Address::generate(&fx.env), 1_i128).into_val(&fx.env),
        })],
    );
    let res = fx.policy.try_policy__(&fx.wallet, &signer_key(&fx), &ctx);
    assert_eq!(res, contract_err(PolicyError::ContextMismatch));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_transfer_with_extra_args() {
    // Four args is not the SEP-41 transfer shape: fail closed.
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    let ctx = Vec::from_array(
        &fx.env,
        [Context::Contract(ContractContext {
            contract: Address::generate(&fx.env),
            fn_name: symbol_short!("transfer"),
            args: (
                fx.wallet.clone(),
                Address::generate(&fx.env),
                1_i128,
                1_i128,
            )
                .into_val(&fx.env),
        })],
    );
    fx.policy.policy__(&fx.wallet, &signer_key(&fx), &ctx);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_non_address_from_arg() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    let ctx = Vec::from_array(
        &fx.env,
        [Context::Contract(ContractContext {
            contract: Address::generate(&fx.env),
            fn_name: symbol_short!("transfer"),
            args: (7_u32, Address::generate(&fx.env), 1_i128).into_val(&fx.env),
        })],
    );
    fx.policy.policy__(&fx.wallet, &signer_key(&fx), &ctx);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_transfer_to_wallet_itself() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    let ctx = Vec::from_array(
        &fx.env,
        [Context::Contract(ContractContext {
            contract: Address::generate(&fx.env),
            fn_name: symbol_short!("transfer"),
            args: (fx.wallet.clone(), fx.wallet.clone(), 1_i128).into_val(&fx.env),
        })],
    );
    fx.policy.policy__(&fx.wallet, &signer_key(&fx), &ctx);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_empty_contexts() {
    // An empty authorization authorizes nothing; refuse rather than
    // rubber-stamp a vacuous auth.
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &Vec::new(&fx.env));
}

// ----- Bounded work -----

fn many_transfers(fx: &Fixture, count: u32, amount: i128) -> Vec<Context> {
    let token = Address::generate(&fx.env);
    let dest = Address::generate(&fx.env);
    let mut ctx = Vec::new(&fx.env);
    for _ in 0..count {
        ctx.push_back(Context::Contract(ContractContext {
            contract: token.clone(),
            fn_name: symbol_short!("transfer"),
            args: (fx.wallet.clone(), dest.clone(), amount).into_val(&fx.env),
        }));
    }
    ctx
}

#[test]
fn evaluates_up_to_max_contexts() {
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &many_transfers(&fx, MAX_CONTEXTS, 1),
    );
}

#[test]
fn refuses_more_than_max_contexts_before_doing_any_work() {
    // MAX_CONTEXTS + 1 contexts of 1 stroop each is well under every limit —
    // the ONLY reason it fails is the context bound, and it fails before the
    // loop runs (no budget is consumed: the follow-up spend of the full cap
    // still passes).
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    let res = fx.policy.try_policy__(
        &fx.wallet,
        &signer_key(&fx),
        &many_transfers(&fx, MAX_CONTEXTS + 1, 1),
    );
    assert_eq!(res, contract_err(PolicyError::TooManyContexts));
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM),
    );
}

// ----- Re-simulation safety -----

/// Re-create the fixture's world inside another Env restored from a ledger
/// snapshot. Object handles are per-Env, so addresses round-trip through their
/// strkey form; the (native, non-wasm) policy is re-registered AT ITS ORIGINAL
/// ADDRESS with the identical immutable constructor args, so its persistent
/// state (install marker, spend record) is exactly what the snapshot holds.
fn rehost(env: &Env, fx: &Fixture) -> (ContractClient<'static>, Address, Address, Address) {
    use std::string::ToString as _;
    let wallet = Address::from_str(env, &fx.wallet.to_string().to_string());
    let policy_id = Address::from_str(env, &fx.policy.address.to_string().to_string());
    env.register_at(
        &policy_id,
        Contract,
        (wallet.clone(), TEN_XLM, DAY, no_rules(env)),
    );
    // Token/destination addresses generated in the ORIGINAL env (so they can
    // never collide with the wallet or policy ids), round-tripped the same way.
    let token = Address::from_str(env, &Address::generate(&fx.env).to_string().to_string());
    let dest = Address::from_str(env, &Address::generate(&fx.env).to_string().to_string());
    (ContractClient::new(env, &policy_id), wallet, token, dest)
}

fn ctx_in(
    env: &Env,
    wallet: &Address,
    token: &Address,
    dest: &Address,
    amount: i128,
) -> Vec<Context> {
    Vec::from_array(
        env,
        [Context::Contract(ContractContext {
            contract: token.clone(),
            fn_name: symbol_short!("transfer"),
            args: (wallet.clone(), dest.clone(), amount).into_val(env),
        })],
    )
}

#[test]
fn repeated_simulation_does_not_consume_budget_and_settlement_does() {
    // A facilitator dry-runs the payment several times before settling. Each
    // simulation evaluates policy__ against the SAME committed state (the
    // simulation's writes are discarded), so the verdict is identical every
    // time and no budget is consumed until the transaction actually applies.
    // Model it with ledger snapshots: evaluate, roll back, evaluate again.
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    let committed = fx.env.to_ledger_snapshot();

    for i in 0..3_u32 {
        let sim_env = Env::from_ledger_snapshot(committed.clone());
        sim_env.mock_all_auths();
        // Each dry-run happens at a later ledger (as it would on the network).
        sim_env.ledger().with_mut(|l| l.sequence_number += i + 1);
        let (sim_policy, wallet, token, dest) = rehost(&sim_env, &fx);
        let key = SignerKey::Policy(sim_policy.address.clone());
        // Test-harness detail: the restored env's mock-auth nonce PRNG restarts
        // from the same seed as the original, so its first draw collides with
        // the nonce `install` already recorded in the snapshot. Burn that draw
        // with a call that is rejected before touching any state.
        assert!(sim_policy
            .try_policy__(&wallet, &key, &Vec::new(&sim_env))
            .is_err());
        // The FULL cap is available on every simulation: nothing was consumed
        // by the previous dry-runs.
        sim_policy.policy__(
            &wallet,
            &key,
            &ctx_in(&sim_env, &wallet, &token, &dest, TEN_XLM),
        );
    }

    // Settlement applies once against the committed state: the cap is
    // consumed and a further stroop is rejected.
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, TEN_XLM),
    );
    let res = fx.policy.try_policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, 1),
    );
    assert_eq!(res, contract_err(PolicyError::NotAllowed));
}

#[test]
fn verdict_is_deterministic_for_identical_state_and_contexts() {
    // Same snapshot, same contexts, same timestamp → same verdict, both for an
    // accept and for a reject.
    let fx = setup(TEN_XLM, DAY, false);
    install(&fx);
    let committed = fx.env.to_ledger_snapshot();
    let mut verdicts = std::vec::Vec::new();
    for _ in 0..3 {
        let sim_env = Env::from_ledger_snapshot(committed.clone());
        sim_env.mock_all_auths();
        let (sim_policy, wallet, token, dest) = rehost(&sim_env, &fx);
        let key = SignerKey::Policy(sim_policy.address.clone());
        let over = sim_policy
            .try_policy__(
                &wallet,
                &key,
                &ctx_in(&sim_env, &wallet, &token, &dest, TEN_XLM + 1),
            )
            .is_ok();
        let ok = sim_policy
            .try_policy__(
                &wallet,
                &key,
                &ctx_in(&sim_env, &wallet, &token, &dest, TEN_XLM),
            )
            .is_ok();
        verdicts.push((ok, over));
    }
    assert!(verdicts.iter().all(|v| *v == (true, false)));
}
