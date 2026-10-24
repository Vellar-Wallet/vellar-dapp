#![cfg(test)]

//! Tests for the verified-recipient policy.
//!
//! The registry in these tests is the REAL `vela-attestation-registry`
//! contract (in-tree dev-dependency), so the cross-contract `is_verified`
//! call — the entire point of this policy — is exercised genuinely: attested
//! contracts pass, unattested/expired/revoked ones fail the whole auth
//! closed.
//!
//! As in the sibling policy suites, the wallet is a minimal stub implementing
//! just the `get_signer` view `uninstall` reads, and `mock_all_auths` stands
//! in for the invoker auth the real wallet provides during `__check_auth`
//! (attestor-auth specificity is covered by the registry's own suite).

extern crate std;

use smart_wallet_interface::types::{SignerExpiration, SignerKey, SignerLimits, SignerVal};
use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env, IntoVal, Vec,
};

use crate::{Config, Contract, ContractClient, PolicyError, ProvenanceMode, MAX_CONTEXTS};
use vela_attestation_registry::{Contract as Registry, ContractClient as RegistryClient};

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

struct Fixture {
    env: Env,
    policy: ContractClient<'static>,
    registry: RegistryClient<'static>,
    wallet: Address,
}

fn setup(wallet_still_signer: bool) -> Fixture {
    setup_mode(wallet_still_signer, |_| ProvenanceMode::Strict)
}

/// Deploy with an explicit provenance mode (built from the env so a
/// trusted-publisher set can be constructed).
fn setup_mode(wallet_still_signer: bool, mode: impl FnOnce(&Env) -> ProvenanceMode) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let attestor = Address::generate(&env);
    let registry_id = env.register(Registry, (attestor,));
    let registry = RegistryClient::new(&env, &registry_id);

    let wallet = env.register(MockWallet, (wallet_still_signer,));
    let mode = mode(&env);
    let policy_id = env.register(Contract, (wallet.clone(), registry_id.clone(), mode));
    let policy = ContractClient::new(&env, &policy_id);

    Fixture {
        env,
        policy,
        registry,
        wallet,
    }
}

/// Attest `contract` as verified for the next 1000 ledgers.
fn attest(fx: &Fixture, contract: &Address) {
    let expires = fx.env.ledger().sequence() + 1000;
    fx.registry.upsert(
        contract,
        &BytesN::from_array(&fx.env, &[0xAB; 32]),
        &expires,
    );
}

/// A transfer-shaped context invoking `token` from the wallet.
fn ctx_for(fx: &Fixture, token: &Address) -> Context {
    let dest = Address::generate(&fx.env);
    let args: Vec<soroban_sdk::Val> = (fx.wallet.clone(), dest, 1_i128).into_val(&fx.env);
    Context::Contract(ContractContext {
        contract: token.clone(),
        fn_name: symbol_short!("transfer"),
        args,
    })
}

fn single(fx: &Fixture, token: &Address) -> Vec<Context> {
    Vec::from_array(&fx.env, [ctx_for(fx, token)])
}

fn install(fx: &Fixture) {
    fx.policy.install(&fx.wallet);
}

fn signer_key(fx: &Fixture) -> SignerKey {
    SignerKey::Policy(fx.policy.address.clone())
}

// ----- Constructor + config -----

#[test]
fn constructor_stores_config() {
    let fx = setup(false);
    assert_eq!(
        fx.policy.config(),
        Config {
            wallet: fx.wallet.clone(),
            registry: fx.registry.address.clone(),
            mode: ProvenanceMode::Strict,
        }
    );
}

// ----- Install binding -----

#[test]
#[should_panic(expected = "Error(Contract, #5)")] // WrongWallet
fn install_rejects_unbound_wallet() {
    let fx = setup(false);
    let other = fx.env.register(MockWallet, (false,));
    fx.policy.install(&other);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")] // NotInstalled
fn policy_rejects_before_install() {
    let fx = setup(false);
    let token = Address::generate(&fx.env);
    attest(&fx, &token);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &single(&fx, &token));
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")] // WrongWallet
fn policy_rejects_unbound_wallet() {
    let fx = setup(false);
    install(&fx);
    let other = fx.env.register(MockWallet, (false,));
    let token = Address::generate(&fx.env);
    attest(&fx, &token);
    fx.policy
        .policy__(&other, &signer_key(&fx), &single(&fx, &token));
}

// ----- The core check: attested passes, everything else fails closed -----

#[test]
fn allows_invocation_of_attested_contract() {
    let fx = setup(false);
    install(&fx);
    let token = Address::generate(&fx.env);
    attest(&fx, &token);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &single(&fx, &token));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")] // NotAllowed
fn rejects_unattested_contract() {
    let fx = setup(false);
    install(&fx);
    let token = Address::generate(&fx.env);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &single(&fx, &token));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")] // NotAllowed
fn rejects_expired_attestation() {
    let fx = setup(false);
    install(&fx);
    let token = Address::generate(&fx.env);
    let expires = fx.env.ledger().sequence() + 10;
    fx.registry
        .upsert(&token, &BytesN::from_array(&fx.env, &[0x01; 32]), &expires);

    fx.env.ledger().with_mut(|l| l.sequence_number = expires);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &single(&fx, &token));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")] // NotAllowed
fn rejects_revoked_attestation() {
    let fx = setup(false);
    install(&fx);
    let token = Address::generate(&fx.env);
    attest(&fx, &token);
    fx.registry.revoke(&token);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &single(&fx, &token));
}

#[test]
fn allows_multi_context_when_all_attested() {
    let fx = setup(false);
    install(&fx);
    let a = Address::generate(&fx.env);
    let b = Address::generate(&fx.env);
    attest(&fx, &a);
    attest(&fx, &b);
    let contexts = Vec::from_array(&fx.env, [ctx_for(&fx, &a), ctx_for(&fx, &b)]);
    fx.policy.policy__(&fx.wallet, &signer_key(&fx), &contexts);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")] // NotAllowed
fn one_unattested_context_fails_the_whole_auth() {
    let fx = setup(false);
    install(&fx);
    let attested = Address::generate(&fx.env);
    let unattested = Address::generate(&fx.env);
    attest(&fx, &attested);
    let contexts = Vec::from_array(
        &fx.env,
        [ctx_for(&fx, &attested), ctx_for(&fx, &unattested)],
    );
    fx.policy.policy__(&fx.wallet, &signer_key(&fx), &contexts);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")] // NotAllowed
fn rejects_wallet_admin_surface_even_if_wallet_attested() {
    let fx = setup(false);
    install(&fx);
    // Attest the wallet itself — the admin-surface guard must still refuse.
    attest(&fx, &fx.wallet.clone());
    let args: Vec<soroban_sdk::Val> = Vec::new(&fx.env);
    let contexts = Vec::from_array(
        &fx.env,
        [Context::Contract(ContractContext {
            contract: fx.wallet.clone(),
            fn_name: symbol_short!("upgrade"),
            args,
        })],
    );
    fx.policy.policy__(&fx.wallet, &signer_key(&fx), &contexts);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")] // NotAllowed
fn rejects_empty_contexts() {
    let fx = setup(false);
    install(&fx);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &Vec::new(&fx.env));
}

// #591: a recipient contract verified at the moment `policy__` evaluates it,
// with its verification revoked by ANOTHER transaction landing in the same
// ledger, is a same-ledger-ordering edge case worth pinning explicitly.
//
// DOCUMENTED BEHAVIOR: `policy__` makes exactly ONE synchronous
// `is_verified` read at the instant it executes (see `check_provenance` in
// lib.rs). Soroban applies transactions within a ledger sequentially, not
// concurrently — there is no interleaving of two transactions' storage
// writes mid-execution of a third. So "revoked earlier in the same ledger"
// and "revoked in an earlier ledger" are not actually different cases from
// this contract's point of view: whichever of `revoke` or `policy__` the
// ledger applies LAST sees the other's effect, deterministically, never a
// stale snapshot. This is NOT dependent on incidental same-ledger
// sub-second timestamp granularity — it falls out of Soroban's sequential
// transaction-apply model. These two tests pin both orderings within one
// ledger sequence number, so a change that made ordering nondeterministic
// (e.g. introducing a cached/batched registry read) would break one of them.
#[test]
#[should_panic(expected = "Error(Contract, #1)")] // NotAllowed
fn revoke_before_policy_check_in_the_same_ledger_is_seen() {
    // Both the revoke and the policy check are modeled as landing in the same
    // ledger sequence number (no `set_timestamp`/`sequence_number` bump
    // between them) — only their RELATIVE ORDER differs from the companion
    // test below. revoke-then-check must reject: the check sees the
    // already-revoked state.
    let fx = setup(false);
    install(&fx);
    let token = Address::generate(&fx.env);
    attest(&fx, &token);
    let ledger_seq = fx.env.ledger().sequence();

    fx.registry.revoke(&token);
    assert_eq!(
        fx.env.ledger().sequence(),
        ledger_seq,
        "still the same ledger"
    );

    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &single(&fx, &token));
}

#[test]
fn policy_check_before_revoke_in_the_same_ledger_still_passes() {
    // Companion to the test above, same ledger sequence number, OPPOSITE
    // order: check-then-revoke must pass — the check ran while the
    // attestation was still live, and a revocation that lands afterwards
    // (even in the same ledger) cannot retroactively undo an authorization
    // that already completed. Proves the outcome tracks actual apply order,
    // not "anything revoked this ledger is treated as never having been
    // verified."
    let fx = setup(false);
    install(&fx);
    let token = Address::generate(&fx.env);
    attest(&fx, &token);
    let ledger_seq = fx.env.ledger().sequence();

    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &single(&fx, &token));

    fx.registry.revoke(&token);
    assert_eq!(
        fx.env.ledger().sequence(),
        ledger_seq,
        "still the same ledger"
    );

    // A SUBSEQUENT check in that same (now-revoked) ledger correctly fails —
    // confirming the revoke really did take effect and the prior pass wasn't
    // a fluke of test setup.
    assert!(fx
        .policy
        .try_policy__(&fx.wallet, &signer_key(&fx), &single(&fx, &token))
        .is_err());
}

#[test]
fn reattestation_restores_authorization() {
    let fx = setup(false);
    install(&fx);
    let token = Address::generate(&fx.env);
    attest(&fx, &token);
    fx.registry.revoke(&token);
    assert!(fx
        .policy
        .try_policy__(&fx.wallet, &signer_key(&fx), &single(&fx, &token))
        .is_err());

    attest(&fx, &token);
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &single(&fx, &token));
}

// ----- Uninstall -----

#[test]
#[should_panic(expected = "Error(Contract, #3)")] // StillInstalled
fn uninstall_refuses_while_still_signer() {
    let fx = setup(true);
    install(&fx);
    fx.policy.uninstall(&fx.wallet);
}

#[test]
fn uninstall_clears_state_once_removed_as_signer() {
    let fx = setup(false);
    install(&fx);
    fx.policy.uninstall(&fx.wallet);
    // After uninstall the install marker is gone: policy__ refuses again.
    let token = Address::generate(&fx.env);
    attest(&fx, &token);
    assert!(fx
        .policy
        .try_policy__(&fx.wallet, &signer_key(&fx), &single(&fx, &token))
        .is_err());
}

// ============================================================================
// #398: provenance modes, explicit auth_contexts parsing, bounded work,
// registry-unavailable fail-closed + recovery, re-simulation.
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

fn publisher(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

/// Attest `contract` as verified AND attributed to `publisher`.
fn attest_by(fx: &Fixture, contract: &Address, publisher: &BytesN<32>) {
    let expires = fx.env.ledger().sequence() + 1000;
    fx.registry.upsert_with_publisher(
        contract,
        &BytesN::from_array(&fx.env, &[0xAB; 32]),
        publisher,
        &expires,
    );
}

fn trusted(byte: u8) -> impl FnOnce(&Env) -> ProvenanceMode {
    move |env| ProvenanceMode::TrustedPublishers(Vec::from_array(env, [publisher(env, byte)]))
}

// ----- Mode config -----

#[test]
fn constructor_stores_trusted_publisher_mode() {
    let fx = setup_mode(false, trusted(0x42));
    assert_eq!(
        fx.policy.config().mode,
        ProvenanceMode::TrustedPublishers(Vec::from_array(&fx.env, [publisher(&fx.env, 0x42)]))
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")] // InvalidConfig
fn constructor_rejects_empty_trusted_set() {
    // An empty trusted set would authorize nothing — a misconfiguration.
    setup_mode(false, |env| {
        ProvenanceMode::TrustedPublishers(Vec::new(env))
    });
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_oversized_trusted_set() {
    setup_mode(false, |env| {
        let mut set = Vec::new(env);
        for i in 0..(crate::MAX_TRUSTED_PUBLISHERS + 1) {
            set.push_back(publisher(env, i as u8));
        }
        ProvenanceMode::TrustedPublishers(set)
    });
}

// ----- Trusted-publishers mode -----

#[test]
fn trusted_mode_allows_contract_attributed_to_trusted_publisher() {
    let fx = setup_mode(false, trusted(0x42));
    install(&fx);
    let token = Address::generate(&fx.env);
    attest_by(&fx, &token, &publisher(&fx.env, 0x42));
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &single(&fx, &token));
}

#[test]
fn trusted_mode_rejects_contract_from_other_publisher() {
    // Verified — but by someone the owner did not trust. This is the case a
    // plain hash allowlist cannot express.
    let fx = setup_mode(false, trusted(0x42));
    install(&fx);
    let token = Address::generate(&fx.env);
    attest_by(&fx, &token, &publisher(&fx.env, 0x99));
    assert!(fx.registry.is_verified(&token));
    let res = fx
        .policy
        .try_policy__(&fx.wallet, &signer_key(&fx), &single(&fx, &token));
    assert_eq!(res, contract_err(PolicyError::UntrustedPublisher));
}

#[test]
fn trusted_mode_rejects_verified_but_unattributed_contract() {
    // A legacy (unattributed) attestation is verified but never trusted.
    let fx = setup_mode(false, trusted(0x42));
    install(&fx);
    let token = Address::generate(&fx.env);
    attest(&fx, &token);
    assert!(fx.registry.is_verified(&token));
    let res = fx
        .policy
        .try_policy__(&fx.wallet, &signer_key(&fx), &single(&fx, &token));
    assert_eq!(res, contract_err(PolicyError::NotAllowed));
}

#[test]
fn trusted_mode_rejects_unverified_contract() {
    let fx = setup_mode(false, trusted(0x42));
    install(&fx);
    let token = Address::generate(&fx.env);
    let res = fx
        .policy
        .try_policy__(&fx.wallet, &signer_key(&fx), &single(&fx, &token));
    assert_eq!(res, contract_err(PolicyError::NotAllowed));
}

#[test]
fn trusted_mode_rejects_after_attribution_expires() {
    let fx = setup_mode(false, trusted(0x42));
    install(&fx);
    let token = Address::generate(&fx.env);
    let expires = fx.env.ledger().sequence() + 10;
    fx.registry.upsert_with_publisher(
        &token,
        &BytesN::from_array(&fx.env, &[0x01; 32]),
        &publisher(&fx.env, 0x42),
        &expires,
    );
    fx.policy
        .policy__(&fx.wallet, &signer_key(&fx), &single(&fx, &token));
    fx.env.ledger().with_mut(|l| l.sequence_number = expires);
    assert!(fx
        .policy
        .try_policy__(&fx.wallet, &signer_key(&fx), &single(&fx, &token))
        .is_err());
}

#[test]
fn trusted_mode_multi_publisher_set_and_batch() {
    let fx = setup_mode(false, |env| {
        ProvenanceMode::TrustedPublishers(Vec::from_array(
            env,
            [publisher(env, 0x01), publisher(env, 0x02)],
        ))
    });
    install(&fx);
    let a = Address::generate(&fx.env);
    let b = Address::generate(&fx.env);
    let c = Address::generate(&fx.env);
    attest_by(&fx, &a, &publisher(&fx.env, 0x01));
    attest_by(&fx, &b, &publisher(&fx.env, 0x02));
    attest_by(&fx, &c, &publisher(&fx.env, 0x03));
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &Vec::from_array(&fx.env, [ctx_for(&fx, &a), ctx_for(&fx, &b)]),
    );
    let res = fx.policy.try_policy__(
        &fx.wallet,
        &signer_key(&fx),
        &Vec::from_array(&fx.env, [ctx_for(&fx, &a), ctx_for(&fx, &c)]),
    );
    assert_eq!(res, contract_err(PolicyError::UntrustedPublisher));
}

// ----- Explicit auth_contexts parsing -----

#[test]
fn rejects_mismatched_transfer_context_from_is_not_the_wallet() {
    // Verified token, but the transfer's `from` is a stranger: not an
    // authorization this wallet's policy governs.
    let fx = setup(false);
    install(&fx);
    let token = Address::generate(&fx.env);
    attest(&fx, &token);
    let stranger = Address::generate(&fx.env);
    let args: Vec<soroban_sdk::Val> =
        (stranger, Address::generate(&fx.env), 1_i128).into_val(&fx.env);
    let ctx = Vec::from_array(
        &fx.env,
        [Context::Contract(ContractContext {
            contract: token,
            fn_name: symbol_short!("transfer"),
            args,
        })],
    );
    let res = fx.policy.try_policy__(&fx.wallet, &signer_key(&fx), &ctx);
    assert_eq!(res, contract_err(PolicyError::ContextMismatch));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_malformed_transfer_shape() {
    // `transfer` with the wrong arity on a verified contract: fail closed.
    let fx = setup(false);
    install(&fx);
    let token = Address::generate(&fx.env);
    attest(&fx, &token);
    let args: Vec<soroban_sdk::Val> = (fx.wallet.clone(), 1_i128).into_val(&fx.env);
    let ctx = Vec::from_array(
        &fx.env,
        [Context::Contract(ContractContext {
            contract: token,
            fn_name: symbol_short!("transfer"),
            args,
        })],
    );
    fx.policy.policy__(&fx.wallet, &signer_key(&fx), &ctx);
}

#[test]
fn allows_non_transfer_invocation_of_verified_contract() {
    // This policy gates WHAT CODE is called; other functions on a verified
    // contract are permitted (amount control is the spending policy's job).
    let fx = setup(false);
    install(&fx);
    let verified = Address::generate(&fx.env);
    attest(&fx, &verified);
    let args: Vec<soroban_sdk::Val> = (fx.wallet.clone(), 1_i128).into_val(&fx.env);
    let ctx = Vec::from_array(
        &fx.env,
        [Context::Contract(ContractContext {
            contract: verified,
            fn_name: symbol_short!("approve"),
            args,
        })],
    );
    fx.policy.policy__(&fx.wallet, &signer_key(&fx), &ctx);
}

// ----- Bounded work -----

fn many_contexts(fx: &Fixture, count: u32) -> Vec<Context> {
    let token = Address::generate(&fx.env);
    attest(fx, &token);
    let mut ctx = Vec::new(&fx.env);
    for _ in 0..count {
        ctx.push_back(ctx_for(fx, &token));
    }
    ctx
}

#[test]
fn evaluates_up_to_max_contexts() {
    let fx = setup(false);
    install(&fx);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &many_contexts(&fx, MAX_CONTEXTS),
    );
}

#[test]
fn refuses_more_than_max_contexts() {
    // Every context is verified — the ONLY reason this fails is the bound.
    let fx = setup(false);
    install(&fx);
    let res = fx.policy.try_policy__(
        &fx.wallet,
        &signer_key(&fx),
        &many_contexts(&fx, MAX_CONTEXTS + 1),
    );
    assert_eq!(res, contract_err(PolicyError::TooManyContexts));
}

// ----- Registry unavailable: fail closed, recovery stays open -----

#[test]
fn registry_unavailable_fails_closed() {
    // An instance bound to a registry address with NO contract behind it
    // (archived / wrong network / never deployed): the cross-contract read
    // traps and every covered authorization fails. Nothing is waved through.
    let env = Env::default();
    env.mock_all_auths();
    let wallet = env.register(MockWallet, (false,));
    let missing_registry = Address::generate(&env);
    let policy_id = env.register(
        Contract,
        (wallet.clone(), missing_registry, ProvenanceMode::Strict),
    );
    let policy = ContractClient::new(&env, &policy_id);
    policy.install(&wallet);
    let token = Address::generate(&env);
    let dest = Address::generate(&env);
    let args: Vec<soroban_sdk::Val> = (wallet.clone(), dest, 1_i128).into_val(&env);
    let ctx = Vec::from_array(
        &env,
        [Context::Contract(ContractContext {
            contract: token,
            fn_name: symbol_short!("transfer"),
            args,
        })],
    );
    assert!(policy
        .try_policy__(&wallet, &SignerKey::Policy(policy_id.clone()), &ctx)
        .is_err());
}

#[test]
fn registry_unavailable_does_not_block_detach_recovery() {
    // The recovery path is the wallet removing the policy signer. The smart
    // wallet's remove_signer runs NO policy code (V3), and this contract's own
    // post-removal hook (`uninstall`) never touches the registry — so recovery
    // works even when the registry is gone. Modeled with the mock wallet
    // reporting the signer as already removed.
    let env = Env::default();
    env.mock_all_auths();
    let wallet = env.register(MockWallet, (false,));
    let missing_registry = Address::generate(&env);
    let policy_id = env.register(
        Contract,
        (wallet.clone(), missing_registry, ProvenanceMode::Strict),
    );
    let policy = ContractClient::new(&env, &policy_id);
    policy.install(&wallet);
    policy.uninstall(&wallet);
}

// ----- Re-simulation -----

#[test]
fn repeated_evaluation_is_idempotent_and_deterministic() {
    // The policy holds no per-call mutable state: three dry-runs and a
    // settlement of the same contexts all produce the same verdict, and a
    // rejecting verdict stays rejecting.
    let fx = setup(false);
    install(&fx);
    let ok = Address::generate(&fx.env);
    let bad = Address::generate(&fx.env);
    attest(&fx, &ok);
    for _ in 0..4 {
        fx.policy
            .policy__(&fx.wallet, &signer_key(&fx), &single(&fx, &ok));
        assert_eq!(
            fx.policy
                .try_policy__(&fx.wallet, &signer_key(&fx), &single(&fx, &bad)),
            contract_err(PolicyError::NotAllowed)
        );
    }
}
