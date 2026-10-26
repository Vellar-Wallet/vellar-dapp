#![cfg(test)]

//! Tests for the rule-based spending-limit policy.
//!
//! The window/limit/deny-by-default invariants are identical to the
//! `token-spending-limit` suite. What is new, and what these tests pin down:
//!
//!   * a NON-transfer, commit-shaped call (an x402 verifier's `commit`) counts
//!     against the cap when a rule names it, and is rejected when it does not;
//!   * the amount position is configurable per rule;
//!   * rules are pinned to a contract address AND function name, so a lookalike
//!     contract or a sibling function on the same contract never passes;
//!   * the constructor rejects malformed rule lists.
//!
//! As in the other policies, a minimal mock wallet implements just the
//! `get_signer` view `uninstall` reads, and `mock_all_auths` stands in for the
//! invoker auth the real wallet provides during `__check_auth`.

extern crate std;

use smart_wallet_interface::types::{SignerExpiration, SignerKey, SignerLimits, SignerVal};
use soroban_sdk::{
    auth::{Context, ContractContext, CreateContractHostFnContext, ContractExecutable},
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env, IntoVal, String as SorobanString, Symbol, Val, Vec,
};

use crate::{AmountSource, Config, Contract, ContractClient, SpendRule, TextGuard};

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
/// The sandbox cap attached to the passkey wallet: 1,000,000 base units, which
/// is 0.1 USDC (USDC has 7 decimals on Stellar).
const CAP: i128 = 1_000_000;

struct Fixture {
    env: Env,
    policy: ContractClient<'static>,
    wallet: Address,
    /// A synthetic x402 verifier: `commit(payer, pay_to, amount)`, amount at idx 2.
    verifier: Address,
    /// A synthetic SEP-41 token: `transfer(from, to, amount)`, amount at idx 2.
    token: Address,
}

/// `fn_name` Symbols are env-independent values once built, but building one
/// needs an Env; this keeps the fixtures readable.
fn rule(env: &Env, contract: &Address, fn_name: &str, index: u32) -> SpendRule {
    SpendRule {
        contract: contract.clone(),
        fn_name: Symbol::new(env, fn_name),
        amount: AmountSource::I128Arg(index),
        payer_arg: None,
        text_guards: Vec::new(env),
    }
}

/// Deploy a policy bound to a mock wallet with rules `commit@verifier(idx 2)`
/// and `transfer@token(idx 2)`.
fn setup(limit: i128, window: u64, wallet_still_signer: bool) -> Fixture {
    setup_with_rules(limit, window, wallet_still_signer, |env, verifier, token| {
        Vec::from_array(
            env,
            [
                rule(env, verifier, "commit", 2),
                rule(env, token, "transfer", 2),
            ],
        )
    })
}

fn setup_with_rules(
    limit: i128,
    window: u64,
    wallet_still_signer: bool,
    rules: impl FnOnce(&Env, &Address, &Address) -> Vec<SpendRule>,
) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let wallet = env.register(MockWallet, (wallet_still_signer,));
    let verifier = Address::generate(&env);
    let token = Address::generate(&env);
    let rules = rules(&env, &verifier, &token);
    let policy_id = env.register(Contract, (wallet.clone(), rules, limit, window));
    let policy = ContractClient::new(&env, &policy_id);

    Fixture {
        env,
        policy,
        wallet,
        verifier,
        token,
    }
}

fn install(fx: &Fixture) {
    fx.policy.install(&fx.wallet);
}

fn signer_key(fx: &Fixture) -> SignerKey {
    SignerKey::Policy(fx.policy.address.clone())
}

fn call(fx: &Fixture, contract: &Address, fn_name: &str, args: Vec<Val>) -> Context {
    Context::Contract(ContractContext {
        contract: contract.clone(),
        fn_name: Symbol::new(&fx.env, fn_name),
        args,
    })
}

/// `commit(payer, pay_to, amount)` on the synthetic verifier.
fn commit_ctx(fx: &Fixture, amount: i128) -> Vec<Context> {
    let pay_to = Address::generate(&fx.env);
    let args: Vec<Val> = (fx.wallet.clone(), pay_to, amount).into_val(&fx.env);
    Vec::from_array(&fx.env, [call(fx, &fx.verifier, "commit", args)])
}

fn transfer_ctx(fx: &Fixture, amount: i128) -> Vec<Context> {
    let dest = Address::generate(&fx.env);
    let args: Vec<Val> = (fx.wallet.clone(), dest, amount).into_val(&fx.env);
    Vec::from_array(&fx.env, [call(fx, &fx.token, "transfer", args)])
}

fn run(fx: &Fixture, ctx: &Vec<Context>) {
    fx.policy.policy__(&fx.wallet, &signer_key(fx), ctx);
}

fn try_run(fx: &Fixture, ctx: &Vec<Context>) -> bool {
    matches!(
        fx.policy.try_policy__(&fx.wallet, &signer_key(fx), ctx),
        Ok(Ok(()))
    )
}

// ----- Constructor validation -----

#[test]
fn constructor_stores_config() {
    let fx = setup(CAP, DAY, false);
    let config = fx.policy.config();
    assert_eq!(config.wallet, fx.wallet);
    assert_eq!(config.daily_limit, CAP);
    assert_eq!(config.window_seconds, DAY);
    assert_eq!(config.rules.len(), 2);
    assert_eq!(
        config.rules.get(0).unwrap(),
        rule(&fx.env, &fx.verifier, "commit", 2)
    );
    let _: Config = config;
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
    setup(CAP, 0, false);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_window_over_max() {
    setup(CAP, DAY * 366, false);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_empty_rules() {
    setup_with_rules(CAP, DAY, false, |env, _, _| Vec::new(env));
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_too_many_rules() {
    // MAX_RULES is 8: nine distinct function names on one contract is too many.
    setup_with_rules(CAP, DAY, false, |env, verifier, _| {
        let names = ["f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"];
        let mut rules = Vec::new(env);
        for name in names {
            rules.push_back(rule(env, verifier, name, 0));
        }
        rules
    });
}

#[test]
fn constructor_accepts_exactly_max_rules() {
    let fx = setup_with_rules(CAP, DAY, false, |env, verifier, _| {
        let names = ["f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7"];
        let mut rules = Vec::new(env);
        for name in names {
            rules.push_back(rule(env, verifier, name, 0));
        }
        rules
    });
    assert_eq!(fx.policy.config().rules.len(), 8);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_duplicate_rule() {
    setup_with_rules(CAP, DAY, false, |env, verifier, _| {
        Vec::from_array(
            env,
            [
                rule(env, verifier, "commit", 2),
                // Same (contract, fn_name), different index: ambiguous, rejected.
                rule(env, verifier, "commit", 1),
            ],
        )
    });
}

#[test]
fn constructor_allows_same_fn_name_on_different_contracts() {
    let fx = setup_with_rules(CAP, DAY, false, |env, verifier, token| {
        Vec::from_array(
            env,
            [
                rule(env, verifier, "transfer", 2),
                rule(env, token, "transfer", 2),
            ],
        )
    });
    assert_eq!(fx.policy.config().rules.len(), 2);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_arg_index_over_max() {
    setup_with_rules(CAP, DAY, false, |env, verifier, _| {
        Vec::from_array(env, [rule(env, verifier, "commit", 16)])
    });
}

#[test]
fn constructor_accepts_arg_index_at_max() {
    let fx = setup_with_rules(CAP, DAY, false, |env, verifier, _| {
        Vec::from_array(env, [rule(env, verifier, "commit", 15)])
    });
    assert_eq!(fx.policy.config().rules.len(), 1);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_rule_targeting_the_wallet() {
    // The wallet address is created inside setup, so build the instance by hand.
    let env = Env::default();
    env.mock_all_auths();
    let wallet = env.register(MockWallet, (false,));
    let rules = Vec::from_array(&env, [rule(&env, &wallet, "commit", 2)]);
    env.register(Contract, (wallet, rules, CAP, DAY));
}

// ----- install / wrong-wallet binding -----

#[test]
fn install_marks_installed() {
    let fx = setup(CAP, DAY, false);
    install(&fx);
    run(&fx, &commit_ctx(&fx, 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")] // WrongWallet
fn install_rejects_other_wallet() {
    let fx = setup(CAP, DAY, false);
    let other = Address::generate(&fx.env);
    fx.policy.install(&other);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn policy_rejects_other_wallet_source() {
    let fx = setup(CAP, DAY, false);
    install(&fx);
    let other = Address::generate(&fx.env);
    fx.policy
        .policy__(&other, &signer_key(&fx), &commit_ctx(&fx, 1));
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")] // NotInstalled
fn policy_rejects_before_install() {
    let fx = setup(CAP, DAY, false);
    run(&fx, &commit_ctx(&fx, 1));
}

// ----- The point of this variant: commit-shaped calls are capped -----

#[test]
fn commit_under_cap_is_allowed() {
    let fx = setup(CAP, DAY, false);
    install(&fx);
    run(&fx, &commit_ctx(&fx, CAP / 2));
}

#[test]
fn commit_exactly_at_cap_is_allowed() {
    let fx = setup(CAP, DAY, false);
    install(&fx);
    run(&fx, &commit_ctx(&fx, CAP));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")] // NotAllowed
fn commit_over_cap_is_rejected() {
    let fx = setup(CAP, DAY, false);
    install(&fx);
    run(&fx, &commit_ctx(&fx, CAP + 1));
}

#[test]
fn commit_amounts_accumulate_within_window() {
    let fx = setup(CAP, DAY, false);
    install(&fx);
    run(&fx, &commit_ctx(&fx, 600_000));
    run(&fx, &commit_ctx(&fx, 400_000));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn commit_rejects_cumulative_over_cap() {
    let fx = setup(CAP, DAY, false);
    install(&fx);
    run(&fx, &commit_ctx(&fx, 600_000));
    run(&fx, &commit_ctx(&fx, 400_001));
}

#[test]
fn rejected_commit_does_not_consume_allowance() {
    let fx = setup(CAP, DAY, false);
    install(&fx);
    assert!(!try_run(&fx, &commit_ctx(&fx, CAP + 1)));
    // The failed attempt rolled back; the full cap is still available.
    run(&fx, &commit_ctx(&fx, CAP));
}

#[test]
fn commit_and_transfer_share_one_cap() {
    let fx = setup(CAP, DAY, false);
    install(&fx);
    run(&fx, &commit_ctx(&fx, 700_000));
    // 700k (commit) + 300k (transfer) == cap: allowed. One more unit: rejected.
    run(&fx, &transfer_ctx(&fx, 300_000));
    assert!(!try_run(&fx, &transfer_ctx(&fx, 1)));
    assert!(!try_run(&fx, &commit_ctx(&fx, 1)));
}

#[test]
fn batch_of_commits_within_cap_is_allowed() {
    let fx = setup(CAP, DAY, false);
    install(&fx);
    let mut ctx = commit_ctx(&fx, 400_000);
    ctx.push_back(commit_ctx(&fx, 600_000).get(0).unwrap());
    run(&fx, &ctx);
}

#[test]
fn batch_of_commits_over_cap_is_rejected() {
    let fx = setup(CAP, DAY, false);
    install(&fx);
    let mut ctx = commit_ctx(&fx, 600_000);
    ctx.push_back(commit_ctx(&fx, 600_000).get(0).unwrap());
    assert!(!try_run(&fx, &ctx));
}

// ----- Configurable amount position -----

#[test]
fn reads_amount_from_configured_arg_index() {
    // A verifier whose debit call is `commit(amount, pay_to)`: amount at idx 0.
    let fx = setup_with_rules(CAP, DAY, false, |env, verifier, _| {
        Vec::from_array(env, [rule(env, verifier, "commit", 0)])
    });
    install(&fx);
    let pay_to = Address::generate(&fx.env);
    let mk = |amount: i128| {
        let args: Vec<Val> = (amount, pay_to.clone()).into_val(&fx.env);
        Vec::from_array(&fx.env, [call(&fx, &fx.verifier, "commit", args)])
    };
    run(&fx, &mk(CAP));
    assert!(!try_run(&fx, &mk(1)), "cap already spent via idx 0");
}

#[test]
fn amount_is_not_read_from_the_wrong_index() {
    // Rule says idx 0 but the caller puts a small number at idx 2 and a large
    // one at idx 0: the policy must count idx 0 only.
    let fx = setup_with_rules(CAP, DAY, false, |env, verifier, _| {
        Vec::from_array(env, [rule(env, verifier, "commit", 0)])
    });
    install(&fx);
    let args: Vec<Val> = (CAP + 1, Address::generate(&fx.env), 1_i128).into_val(&fx.env);
    let ctx = Vec::from_array(&fx.env, [call(&fx, &fx.verifier, "commit", args)]);
    assert!(!try_run(&fx, &ctx));
}

// ----- Deny-by-default -----

#[test]
fn rejects_other_fn_on_rule_contract() {
    // `verify` on the verifier has no rule: only `commit` is spend-worthy.
    let fx = setup(CAP, DAY, false);
    install(&fx);
    let args: Vec<Val> = (fx.wallet.clone(), Address::generate(&fx.env), 1_i128).into_val(&fx.env);
    let ctx = Vec::from_array(&fx.env, [call(&fx, &fx.verifier, "verify", args)]);
    assert!(!try_run(&fx, &ctx));
}

#[test]
fn rejects_same_fn_on_lookalike_contract() {
    // `commit` on a contract that is not the configured verifier.
    let fx = setup(CAP, DAY, false);
    install(&fx);
    let lookalike = Address::generate(&fx.env);
    let args: Vec<Val> = (fx.wallet.clone(), Address::generate(&fx.env), 1_i128).into_val(&fx.env);
    let ctx = Vec::from_array(&fx.env, [call(&fx, &lookalike, "commit", args)]);
    assert!(!try_run(&fx, &ctx));
}

#[test]
fn rejects_transfer_on_unlisted_token() {
    let fx = setup(CAP, DAY, false);
    install(&fx);
    let other_token = Address::generate(&fx.env);
    let args: Vec<Val> = (fx.wallet.clone(), Address::generate(&fx.env), 1_i128).into_val(&fx.env);
    let ctx = Vec::from_array(&fx.env, [call(&fx, &other_token, "transfer", args)]);
    assert!(!try_run(&fx, &ctx));
}

#[test]
fn one_unmatched_context_rejects_the_whole_batch() {
    let fx = setup(CAP, DAY, false);
    install(&fx);
    let mut ctx = commit_ctx(&fx, 1);
    let args: Vec<Val> = (fx.wallet.clone(),).into_val(&fx.env);
    ctx.push_back(call(&fx, &fx.verifier, "withdraw", args));
    assert!(!try_run(&fx, &ctx));
}

#[test]
fn rejects_call_targeting_wallet_itself() {
    let fx = setup(CAP, DAY, false);
    install(&fx);
    let args: Vec<Val> = (fx.wallet.clone(), Address::generate(&fx.env), 1_i128).into_val(&fx.env);
    let ctx = Vec::from_array(&fx.env, [call(&fx, &fx.wallet, "commit", args)]);
    assert!(!try_run(&fx, &ctx));
}

#[test]
fn rejects_empty_contexts() {
    let fx = setup(CAP, DAY, false);
    install(&fx);
    assert!(!try_run(&fx, &Vec::new(&fx.env)));
}

#[test]
fn rejects_non_contract_context() {
    let fx = setup(CAP, DAY, false);
    install(&fx);
    let ctx = Vec::from_array(
        &fx.env,
        [Context::CreateContractHostFn(CreateContractHostFnContext {
            executable: ContractExecutable::Wasm(BytesN::from_array(&fx.env, &[0; 32])),
            salt: BytesN::from_array(&fx.env, &[0; 32]),
        })],
    );
    assert!(!try_run(&fx, &ctx));
}

#[test]
fn rejects_zero_amount() {
    let fx = setup(CAP, DAY, false);
    install(&fx);
    assert!(!try_run(&fx, &commit_ctx(&fx, 0)));
}

#[test]
fn rejects_negative_amount() {
    let fx = setup(CAP, DAY, false);
    install(&fx);
    assert!(!try_run(&fx, &commit_ctx(&fx, -5)));
}

#[test]
fn rejects_missing_amount_arg() {
    let fx = setup(CAP, DAY, false);
    install(&fx);
    // Rule reads idx 2; the call only carries two args.
    let args: Vec<Val> = (fx.wallet.clone(), Address::generate(&fx.env)).into_val(&fx.env);
    let ctx = Vec::from_array(&fx.env, [call(&fx, &fx.verifier, "commit", args)]);
    assert!(!try_run(&fx, &ctx));
}

#[test]
fn rejects_non_i128_amount_arg() {
    let fx = setup(CAP, DAY, false);
    install(&fx);
    // The "amount" slot holds a string (e.g. a commitment text), not an i128.
    let text = SorobanString::from_str(&fx.env, "1000000");
    let args: Vec<Val> = (fx.wallet.clone(), Address::generate(&fx.env), text).into_val(&fx.env);
    let ctx = Vec::from_array(&fx.env, [call(&fx, &fx.verifier, "commit", args)]);
    assert!(!try_run(&fx, &ctx));
}

#[test]
fn rejects_amount_sum_overflow() {
    // Two i128::MAX commits would overflow the running total; must fail closed
    // rather than wrap.
    let fx = setup_with_rules(i128::MAX, DAY, false, |env, verifier, _| {
        Vec::from_array(env, [rule(env, verifier, "commit", 2)])
    });
    install(&fx);
    let mut ctx = commit_ctx(&fx, i128::MAX);
    ctx.push_back(commit_ctx(&fx, i128::MAX).get(0).unwrap());
    assert!(!try_run(&fx, &ctx));
}

// ----- Window behavior -----

#[test]
fn window_resets_after_elapse() {
    let fx = setup(CAP, DAY, false);
    install(&fx);
    run(&fx, &commit_ctx(&fx, CAP));
    fx.env
        .ledger()
        .set_timestamp(fx.env.ledger().timestamp() + DAY);
    run(&fx, &commit_ctx(&fx, CAP));
}

#[test]
fn window_does_not_reset_before_elapse() {
    let fx = setup(CAP, DAY, false);
    install(&fx);
    run(&fx, &commit_ctx(&fx, CAP));
    fx.env
        .ledger()
        .set_timestamp(fx.env.ledger().timestamp() + DAY - 1);
    assert!(!try_run(&fx, &commit_ctx(&fx, 1)));
}

#[test]
fn boundary_allows_up_to_twice_the_cap() {
    // Documented tumbling-window property: a full cap just before the reset and
    // a full cap just after is allowed. This pins the documented bound.
    let fx = setup(CAP, DAY, false);
    install(&fx);
    run(&fx, &commit_ctx(&fx, CAP));
    fx.env
        .ledger()
        .set_timestamp(fx.env.ledger().timestamp() + DAY);
    run(&fx, &commit_ctx(&fx, CAP));
    assert!(!try_run(&fx, &commit_ctx(&fx, 1)));
}

// ----- uninstall self-clean -----

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // StillInstalled
fn uninstall_refuses_while_still_signer() {
    let fx = setup(CAP, DAY, true);
    install(&fx);
    fx.policy.uninstall(&fx.wallet);
}

#[test]
fn uninstall_clears_state_once_removed() {
    let fx = setup(CAP, DAY, false);
    install(&fx);
    run(&fx, &commit_ctx(&fx, CAP));
    fx.policy.uninstall(&fx.wallet);
    assert!(!try_run(&fx, &commit_ctx(&fx, 1)));
}

// ----- Fermah x402 verifier: commit(payer: Address, commitment: String) -----
//
// The real call shape, read from fermah-pay-stellar `contracts/x402-verifier`:
// the amount is NOT a typed argument; it is the `amount:` line of a signed
// commitment text (format built by the gateway's `commitment_message`). The
// verifier only checks the payer's authorization and moves nothing; the debit
// happens at /settle. Fermah's vault enforces its own cumulative daily cap per
// buyer; this rule is a secondary per-call ceiling plus shape checks.

fn commitment_text(env: &Env, amount: &str) -> SorobanString {
    let text = std::format!(
        "x402 batch-settlement commitment\n\
         network: stellar:testnet\n\
         asset: CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA\n\
         payTo: CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC\n\
         amount: {amount}\n\
         payer: CCPYR3RZF5FLEHMY65JO47XVVAW4OPNFC65AOFUJ3QSBTM2VOVY2UMNY\n\
         commitment: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n\
         validUntil: 1790000000"
    );
    SorobanString::from_str(env, &text)
}

fn fermah_fx(limit: i128) -> Fixture {
    setup_with_rules(limit, DAY, false, |env, verifier, _| {
        Vec::from_array(
            env,
            [SpendRule {
                contract: verifier.clone(),
                fn_name: Symbol::new(env, "commit"),
                amount: AmountSource::TextLineArg(1, SorobanString::from_str(env, "amount: ")),
                payer_arg: None,
                text_guards: Vec::new(env),
            }],
        )
    })
}

fn verifier_commit(fx: &Fixture, text: SorobanString) -> Vec<Context> {
    let args: Vec<Val> = (fx.wallet.clone(), text).into_val(&fx.env);
    Vec::from_array(&fx.env, [call(fx, &fx.verifier, "commit", args)])
}

fn commit_amount(fx: &Fixture, amount: &str) -> Vec<Context> {
    verifier_commit(fx, commitment_text(&fx.env, amount))
}

#[test]
fn fermah_commit_under_cap_is_allowed() {
    let fx = fermah_fx(CAP);
    install(&fx);
    run(&fx, &commit_amount(&fx, "500000"));
}

#[test]
fn fermah_commit_exactly_at_cap_is_allowed() {
    let fx = fermah_fx(CAP);
    install(&fx);
    run(&fx, &commit_amount(&fx, "1000000"));
}

#[test]
fn fermah_commit_over_cap_is_rejected() {
    let fx = fermah_fx(CAP);
    install(&fx);
    assert!(!try_run(&fx, &commit_amount(&fx, "1000001")));
}

#[test]
fn fermah_commit_cumulative_over_cap_is_rejected() {
    // Holds only for commits that land on-chain; see the module docs.
    let fx = fermah_fx(CAP);
    install(&fx);
    run(&fx, &commit_amount(&fx, "600000"));
    assert!(!try_run(&fx, &commit_amount(&fx, "400001")));
}

#[test]
fn fermah_commit_text_with_no_amount_line_is_rejected() {
    let fx = fermah_fx(CAP);
    install(&fx);
    let text = SorobanString::from_str(&fx.env, "x402 batch-settlement commitment\npayTo: C");
    assert!(!try_run(&fx, &verifier_commit(&fx, text)));
}

#[test]
fn fermah_commit_with_two_amount_lines_is_rejected() {
    // A text carrying `amount:` twice is ambiguous between this policy and the
    // gateway; never pick one.
    let fx = fermah_fx(CAP);
    install(&fx);
    let text = SorobanString::from_str(&fx.env, "amount: 1\namount: 99999999");
    assert!(!try_run(&fx, &verifier_commit(&fx, text)));
}

#[test]
fn fermah_commit_amount_must_start_its_line() {
    // `payTo: xamount: 1` must not count as the amount line.
    let fx = fermah_fx(CAP);
    install(&fx);
    let text = SorobanString::from_str(&fx.env, "payTo: xamount: 1");
    assert!(!try_run(&fx, &verifier_commit(&fx, text)));
}

#[test]
fn fermah_commit_rejects_non_canonical_amounts() {
    let fx = fermah_fx(CAP);
    install(&fx);
    for bad in ["", "-5", "+5", "05", "0", "1.5", "1e6", " 5", "5 ", "0x10", "٣"] {
        assert!(
            !try_run(&fx, &commit_amount(&fx, bad)),
            "amount {bad:?} must be rejected"
        );
    }
}

#[test]
fn fermah_commit_rejects_amount_beyond_i128() {
    let fx = fermah_fx(i128::MAX);
    install(&fx);
    // i128::MAX is 170141183460469231731687303715884105727 (39 digits).
    assert!(try_run(&fx, &commit_amount(&fx, "170141183460469231731687303715884105727")));
    let fx = fermah_fx(i128::MAX);
    install(&fx);
    assert!(!try_run(&fx, &commit_amount(&fx, "170141183460469231731687303715884105728")));
}

#[test]
fn fermah_commit_rejects_oversized_text() {
    let fx = fermah_fx(CAP);
    install(&fx);
    let padding = "x".repeat(2000);
    let text = std::format!("amount: 1\n{padding}");
    assert!(!try_run(&fx, &verifier_commit(&fx, SorobanString::from_str(&fx.env, &text))));
}

#[test]
fn fermah_commit_rejects_non_string_text_arg() {
    let fx = fermah_fx(CAP);
    install(&fx);
    let args: Vec<Val> = (fx.wallet.clone(), 5_i128).into_val(&fx.env);
    let ctx = Vec::from_array(&fx.env, [call(&fx, &fx.verifier, "commit", args)]);
    assert!(!try_run(&fx, &ctx));
}

#[test]
fn constructor_rejects_bad_text_rules() {
    for (index, prefix) in [(16_u32, "amount: "), (1, ""), (1, "a\nb"), (1, &"p".repeat(33)[..])] {
        let env = Env::default();
        env.mock_all_auths();
        let wallet = env.register(MockWallet, (false,));
        let rules = Vec::from_array(
            &env,
            [SpendRule {
                contract: Address::generate(&env),
                fn_name: Symbol::new(&env, "commit"),
                amount: AmountSource::TextLineArg(index, SorobanString::from_str(&env, prefix)),
                payer_arg: None,
                text_guards: Vec::new(&env),
            }],
        );
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            env.register(Contract, (wallet, rules, CAP, DAY))
        }));
        assert!(res.is_err(), "index {index} prefix {prefix:?} must be rejected");
    }
}

// ----- Tightened commit rule: payer arg + text guards -----
//
// The full guarded shape for the Fermah verifier, from the spec: the verifier
// contract and `commit` (the rule pin), the payer argument equal to the wallet,
// the exact format header on line 1, the network line, a payTo allowlist, and
// an amount under the cap. Every guard is exercised on its own: the text under
// test is otherwise valid, so a rejection can only come from the guard named.

const HEADER: &str = "x402 batch-settlement commitment";
const NETWORK: &str = "stellar:testnet";
const VAULT: &str = "CC2M46SYPBN3KYOI32JZBOUKIH7WVDILA5V4HDCCYWIZ6CUA7FFHYXXG";
const VAULT_2: &str = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const EVIL: &str = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

/// The eight-line commitment text with each guarded field overridable.
fn guarded_text(env: &Env, header: &str, network: &str, pay_to: &str, amount: &str) -> SorobanString {
    let text = std::format!(
        "{header}\n\
         network: {network}\n\
         asset: CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA\n\
         payTo: {pay_to}\n\
         amount: {amount}\n\
         payer: CCPYR3RZF5FLEHMY65JO47XVVAW4OPNFC65AOFUJ3QSBTM2VOVY2UMNY\n\
         commitment: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n\
         validUntil: 1790000000"
    );
    SorobanString::from_str(env, &text)
}

fn s(env: &Env, text: &str) -> SorobanString {
    SorobanString::from_str(env, text)
}

/// `guards` for the Fermah shape: header, network, and a two-vault allowlist.
fn fermah_guards(env: &Env) -> Vec<TextGuard> {
    Vec::from_array(
        env,
        [
            TextGuard::FirstLine(s(env, HEADER)),
            TextGuard::LineOneOf(s(env, "network: "), Vec::from_array(env, [s(env, NETWORK)])),
            TextGuard::LineOneOf(
                s(env, "payTo: "),
                Vec::from_array(env, [s(env, VAULT), s(env, VAULT_2)]),
            ),
        ],
    )
}

fn guarded_rule(env: &Env, verifier: &Address, guards: Vec<TextGuard>) -> SpendRule {
    SpendRule {
        contract: verifier.clone(),
        fn_name: Symbol::new(env, "commit"),
        amount: AmountSource::TextLineArg(1, s(env, "amount: ")),
        payer_arg: Some(0),
        text_guards: guards,
    }
}

fn guarded_fx(limit: i128) -> Fixture {
    setup_with_rules(limit, DAY, false, |env, verifier, _| {
        Vec::from_array(env, [guarded_rule(env, verifier, fermah_guards(env))])
    })
}

fn good_text(fx: &Fixture, amount: &str) -> SorobanString {
    guarded_text(&fx.env, HEADER, NETWORK, VAULT, amount)
}

fn assert_rejected(fx: &Fixture, text: SorobanString, why: &str) {
    assert!(!try_run(fx, &verifier_commit(fx, text)), "{why}");
}

#[test]
fn guarded_commit_happy_path_is_allowed() {
    let fx = guarded_fx(CAP);
    install(&fx);
    run(&fx, &verifier_commit(&fx, good_text(&fx, "50000")));
}

#[test]
fn guarded_commit_allows_every_listed_pay_to() {
    let fx = guarded_fx(CAP);
    install(&fx);
    for vault in [VAULT, VAULT_2] {
        let text = guarded_text(&fx.env, HEADER, NETWORK, vault, "1");
        run(&fx, &verifier_commit(&fx, text));
    }
}

#[test]
fn guarded_commit_still_enforces_the_cap() {
    let fx = guarded_fx(CAP);
    install(&fx);
    run(&fx, &verifier_commit(&fx, good_text(&fx, "1000000")));
    assert_rejected(&fx, good_text(&fx, "1"), "cumulative cap still applies when guards pass");
    let fx = guarded_fx(CAP);
    install(&fx);
    assert_rejected(&fx, good_text(&fx, "1000001"), "over-cap amount");
}

#[test]
fn guard_rejection_does_not_consume_allowance() {
    let fx = guarded_fx(CAP);
    install(&fx);
    let evil = guarded_text(&fx.env, HEADER, NETWORK, EVIL, "900000");
    assert_rejected(&fx, evil, "payTo outside allowlist");
    run(&fx, &verifier_commit(&fx, good_text(&fx, "1000000")));
}

// -- payer argument --

#[test]
fn payer_arg_must_equal_the_wallet() {
    let fx = guarded_fx(CAP);
    install(&fx);
    let other = Address::generate(&fx.env);
    let args: Vec<Val> = (other, good_text(&fx, "1")).into_val(&fx.env);
    let ctx = Vec::from_array(&fx.env, [call(&fx, &fx.verifier, "commit", args)]);
    assert!(!try_run(&fx, &ctx), "another account as payer must be rejected");
}

#[test]
fn payer_arg_missing_or_wrong_type_is_rejected() {
    let fx = guarded_fx(CAP);
    install(&fx);
    // Not an Address at index 0.
    let args: Vec<Val> = (5_i128, good_text(&fx, "1")).into_val(&fx.env);
    let ctx = Vec::from_array(&fx.env, [call(&fx, &fx.verifier, "commit", args)]);
    assert!(!try_run(&fx, &ctx), "non-address payer");
    // No arguments at all.
    let ctx = Vec::from_array(&fx.env, [call(&fx, &fx.verifier, "commit", Vec::new(&fx.env))]);
    assert!(!try_run(&fx, &ctx), "missing payer");
}

#[test]
fn payer_arg_is_checked_on_i128_rules_too() {
    // A transfer rule with `from` (index 0) pinned to the wallet.
    let fx = setup_with_rules(CAP, DAY, false, |env, _, token| {
        Vec::from_array(
            env,
            [SpendRule {
                payer_arg: Some(0),
                ..rule(env, token, "transfer", 2)
            }],
        )
    });
    install(&fx);
    run(&fx, &transfer_ctx(&fx, 1));
    let other = Address::generate(&fx.env);
    let dest = Address::generate(&fx.env);
    let args: Vec<Val> = (other, dest, 1_i128).into_val(&fx.env);
    let ctx = Vec::from_array(&fx.env, [call(&fx, &fx.token, "transfer", args)]);
    assert!(!try_run(&fx, &ctx), "transfer from another account");
}

// -- FirstLine --

#[test]
fn first_line_must_match_exactly() {
    let fx = guarded_fx(CAP);
    install(&fx);
    for bad in [
        "x402 batch-settlement commitment ",
        " x402 batch-settlement commitment",
        "X402 batch-settlement commitment",
        "x402 batch-settlement commitment v2",
        "x402 batch-settlement",
        "",
    ] {
        let text = guarded_text(&fx.env, bad, NETWORK, VAULT, "1");
        assert_rejected(&fx, text, "wrong first line");
    }
}

#[test]
fn header_that_is_not_the_first_line_is_rejected() {
    let fx = guarded_fx(CAP);
    install(&fx);
    // Valid header present, but on line 2.
    let text = std::format!(
        "preamble\n{HEADER}\nnetwork: {NETWORK}\npayTo: {VAULT}\namount: 1"
    );
    assert_rejected(&fx, s(&fx.env, &text), "header on line 2");
}

// -- LineOneOf: network --

#[test]
fn network_must_match_exactly() {
    let fx = guarded_fx(CAP);
    install(&fx);
    for bad in [
        "stellar:pubnet",
        "stellar:testnet2",
        "stellar:testnet ",
        " stellar:testnet",
        "Stellar:testnet",
        "",
    ] {
        let text = guarded_text(&fx.env, HEADER, bad, VAULT, "1");
        assert_rejected(&fx, text, "wrong network");
    }
}

#[test]
fn missing_network_line_is_rejected() {
    let fx = guarded_fx(CAP);
    install(&fx);
    let text = std::format!("{HEADER}\npayTo: {VAULT}\namount: 1");
    assert_rejected(&fx, s(&fx.env, &text), "no network line");
}

#[test]
fn lookalike_network_line_does_not_count() {
    // `xnetwork: stellar:testnet` does not start with the guard prefix.
    let fx = guarded_fx(CAP);
    install(&fx);
    let text = std::format!("{HEADER}\nxnetwork: {NETWORK}\npayTo: {VAULT}\namount: 1");
    assert_rejected(&fx, s(&fx.env, &text), "lookalike network line");
}

#[test]
fn duplicate_network_line_is_rejected_in_either_order() {
    let fx = guarded_fx(CAP);
    install(&fx);
    let a = std::format!("{HEADER}\nnetwork: {NETWORK}\nnetwork: stellar:pubnet\npayTo: {VAULT}\namount: 1");
    let b = std::format!("{HEADER}\nnetwork: stellar:pubnet\nnetwork: {NETWORK}\npayTo: {VAULT}\namount: 1");
    assert_rejected(&fx, s(&fx.env, &a), "good then bad network");
    assert_rejected(&fx, s(&fx.env, &b), "bad then good network");
}

// -- LineOneOf: payTo allowlist --

#[test]
fn pay_to_outside_allowlist_is_rejected() {
    let fx = guarded_fx(CAP);
    install(&fx);
    for bad in [EVIL, "", "cc2m46sypbn3kyoi32jzbouKih7wvdila5v4hdccywiz6cua7ffhyxxg"] {
        let text = guarded_text(&fx.env, HEADER, NETWORK, bad, "1");
        assert_rejected(&fx, text, "payTo not allowlisted");
    }
}

#[test]
fn pay_to_prefix_match_alone_is_not_enough() {
    // An allowlisted address followed by more characters is a different value.
    let fx = guarded_fx(CAP);
    install(&fx);
    let text = guarded_text(&fx.env, HEADER, NETWORK, &std::format!("{VAULT}X"), "1");
    assert_rejected(&fx, text, "allowlisted address with a suffix");
}

#[test]
fn missing_pay_to_line_is_rejected() {
    let fx = guarded_fx(CAP);
    install(&fx);
    let text = std::format!("{HEADER}\nnetwork: {NETWORK}\namount: 1");
    assert_rejected(&fx, s(&fx.env, &text), "no payTo line");
}

#[test]
fn duplicate_pay_to_line_is_rejected_in_either_order() {
    let fx = guarded_fx(CAP);
    install(&fx);
    let a = std::format!("{HEADER}\nnetwork: {NETWORK}\npayTo: {VAULT}\npayTo: {EVIL}\namount: 1");
    let b = std::format!("{HEADER}\nnetwork: {NETWORK}\npayTo: {EVIL}\npayTo: {VAULT}\namount: 1");
    assert_rejected(&fx, s(&fx.env, &a), "good then evil payTo");
    assert_rejected(&fx, s(&fx.env, &b), "evil then good payTo");
}

#[test]
fn guards_and_amount_read_the_same_text() {
    // Valid guarded lines plus a second amount line: ambiguous, rejected.
    let fx = guarded_fx(i128::MAX);
    install(&fx);
    let text = std::format!(
        "{HEADER}\nnetwork: {NETWORK}\npayTo: {VAULT}\namount: 1\namount: 99999999"
    );
    assert_rejected(&fx, s(&fx.env, &text), "two amount lines");
}

#[test]
fn payer_text_line_can_be_pinned_to_the_wallet() {
    // No new code path: `payer: ` is just another LineOneOf, configured with
    // the wallet's strkey so the signed text and the typed argument agree. The
    // wallet address only exists after setup, so the wallet is created first
    // and the policy deployed against it.
    let env = Env::default();
    env.mock_all_auths();
    let wallet = env.register(MockWallet, (false,));
    let mut buf = [0u8; 56];
    wallet.to_string().copy_into_slice(&mut buf);
    let wallet_strkey = std::string::String::from_utf8(buf.to_vec()).unwrap();

    let verifier = Address::generate(&env);
    let mut guards = fermah_guards(&env);
    guards.push_back(TextGuard::LineOneOf(
        s(&env, "payer: "),
        Vec::from_array(&env, [s(&env, &wallet_strkey)]),
    ));
    let rules = Vec::from_array(&env, [guarded_rule(&env, &verifier, guards)]);
    let policy_id = env.register(Contract, (wallet.clone(), rules, CAP, DAY));
    let fx = Fixture {
        env: env.clone(),
        policy: ContractClient::new(&env, &policy_id),
        wallet,
        verifier,
        token: Address::generate(&env),
    };
    install(&fx);

    let line = |payer: &str| {
        s(&env, &std::format!(
            "{HEADER}\nnetwork: {NETWORK}\npayTo: {VAULT}\namount: 1\npayer: {payer}"
        ))
    };
    run(&fx, &verifier_commit(&fx, line(&wallet_strkey)));
    assert_rejected(&fx, line(EVIL), "payer line is another account");
}

// -- Constructor validation of the new fields --

/// Assert that deploying with the rule built by `build` is rejected.
fn assert_ctor_rejects(why: &str, build: impl FnOnce(&Env, &Address) -> SpendRule) {
    let env = Env::default();
    env.mock_all_auths();
    let wallet = env.register(MockWallet, (false,));
    let rules = Vec::from_array(&env, [build(&env, &Address::generate(&env))]);
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(Contract, (wallet, rules, CAP, DAY))
    }));
    assert!(res.is_err(), "{why}");
}

fn assert_ctor_accepts(why: &str, build: impl FnOnce(&Env, &Address) -> SpendRule) {
    let env = Env::default();
    env.mock_all_auths();
    let wallet = env.register(MockWallet, (false,));
    let rules = Vec::from_array(&env, [build(&env, &Address::generate(&env))]);
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(Contract, (wallet, rules, CAP, DAY))
    }));
    assert!(res.is_ok(), "{why}");
}

fn with_guards(env: &Env, verifier: &Address, guards: &[TextGuard]) -> SpendRule {
    guarded_rule(env, verifier, Vec::from_slice(env, guards))
}

#[test]
fn constructor_stores_guards_and_payer_arg() {
    let fx = guarded_fx(CAP);
    let rules = fx.policy.config().rules;
    let stored = rules.get(0).unwrap();
    assert_eq!(stored.payer_arg, Some(0));
    assert_eq!(stored.text_guards, fermah_guards(&fx.env));
}

#[test]
fn constructor_rejects_guards_on_an_i128_rule() {
    assert_ctor_rejects("guards need a text amount", |env, c| SpendRule {
        text_guards: fermah_guards(env),
        ..rule(env, c, "commit", 2)
    });
}

#[test]
fn constructor_rejects_payer_arg_over_max() {
    assert_ctor_rejects("payer index 16", |env, c| SpendRule {
        payer_arg: Some(16),
        ..rule(env, c, "commit", 2)
    });
    assert_ctor_accepts("payer index 15", |env, c| SpendRule {
        payer_arg: Some(15),
        ..rule(env, c, "commit", 2)
    });
}

#[test]
fn constructor_rejects_malformed_guards() {
    assert_ctor_rejects("empty FirstLine", |env, c| {
        with_guards(env, c, &[TextGuard::FirstLine(s(env, ""))])
    });
    assert_ctor_rejects("FirstLine with a line break", |env, c| {
        with_guards(env, c, &[TextGuard::FirstLine(s(env, "a\nb"))])
    });
    assert_ctor_rejects("FirstLine over 128 bytes", |env, c| {
        with_guards(env, c, &[TextGuard::FirstLine(s(env, &"h".repeat(129)))])
    });
    assert_ctor_rejects("two FirstLine guards", |env, c| {
        with_guards(
            env,
            c,
            &[TextGuard::FirstLine(s(env, "a")), TextGuard::FirstLine(s(env, "b"))],
        )
    });
    assert_ctor_rejects("empty prefix", |env, c| {
        with_guards(
            env,
            c,
            &[TextGuard::LineOneOf(s(env, ""), Vec::from_array(env, [s(env, "v")]))],
        )
    });
    assert_ctor_rejects("prefix with a line break", |env, c| {
        with_guards(
            env,
            c,
            &[TextGuard::LineOneOf(s(env, "a\nb"), Vec::from_array(env, [s(env, "v")]))],
        )
    });
    assert_ctor_rejects("prefix over 32 bytes", |env, c| {
        with_guards(
            env,
            c,
            &[TextGuard::LineOneOf(s(env, &"p".repeat(33)), Vec::from_array(env, [s(env, "v")]))],
        )
    });
    assert_ctor_rejects("no allowed values", |env, c| {
        with_guards(env, c, &[TextGuard::LineOneOf(s(env, "k: "), Vec::new(env))])
    });
    assert_ctor_rejects("empty allowed value", |env, c| {
        with_guards(
            env,
            c,
            &[TextGuard::LineOneOf(s(env, "k: "), Vec::from_array(env, [s(env, "")]))],
        )
    });
    assert_ctor_rejects("allowed value with a line break", |env, c| {
        with_guards(
            env,
            c,
            &[TextGuard::LineOneOf(s(env, "k: "), Vec::from_array(env, [s(env, "a\nb")]))],
        )
    });
    assert_ctor_rejects("allowed value over 128 bytes", |env, c| {
        with_guards(
            env,
            c,
            &[TextGuard::LineOneOf(
                s(env, "k: "),
                Vec::from_array(env, [s(env, &"v".repeat(129))]),
            )],
        )
    });
    assert_ctor_rejects("repeated prefix", |env, c| {
        with_guards(
            env,
            c,
            &[
                TextGuard::LineOneOf(s(env, "k: "), Vec::from_array(env, [s(env, "a")])),
                TextGuard::LineOneOf(s(env, "k: "), Vec::from_array(env, [s(env, "b")])),
            ],
        )
    });
}

#[test]
fn constructor_enforces_guard_count_and_value_count_bounds() {
    // 8 guards (one FirstLine + 7 distinct prefixes) is the maximum.
    let build = |env: &Env, c: &Address, n: u32| {
        let mut guards = Vec::from_array(env, [TextGuard::FirstLine(s(env, "h"))]);
        for i in 0..n - 1 {
            guards.push_back(TextGuard::LineOneOf(
                s(env, &std::format!("k{i}: ")),
                Vec::from_array(env, [s(env, "v")]),
            ));
        }
        guarded_rule(env, c, guards)
    };
    assert_ctor_accepts("8 guards", |env, c| build(env, c, 8));
    assert_ctor_rejects("9 guards", |env, c| build(env, c, 9));

    let values = |env: &Env, c: &Address, n: u32| {
        let mut vals = Vec::new(env);
        for i in 0..n {
            vals.push_back(s(env, &std::format!("v{i}")));
        }
        with_guards(env, c, &[TextGuard::LineOneOf(s(env, "k: "), vals)])
    };
    assert_ctor_accepts("8 values", |env, c| values(env, c, 8));
    assert_ctor_rejects("9 values", |env, c| values(env, c, 9));
}

#[test]
fn constructor_accepts_max_length_guard_strings() {
    assert_ctor_accepts("128-byte first line and value, 32-byte prefix", |env, c| {
        with_guards(
            env,
            c,
            &[
                TextGuard::FirstLine(s(env, &"h".repeat(128))),
                TextGuard::LineOneOf(
                    s(env, &"p".repeat(32)),
                    Vec::from_array(env, [s(env, &"v".repeat(128))]),
                ),
            ],
        )
    });
}
