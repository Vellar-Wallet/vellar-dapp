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

use crate::{AmountSource, Config, Contract, ContractClient, SpendRule};

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
// happens off-chain at /settle, so the on-chain spend rule is the buyer's only
// consent-time cap.

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
            }],
        );
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            env.register(Contract, (wallet, rules, CAP, DAY))
        }));
        assert!(res.is_err(), "index {index} prefix {prefix:?} must be rejected");
    }
}
