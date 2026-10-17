//! VELA verified-recipient policy: the signer's auth entries may only invoke
//! contracts with a LIVE attestation in the attestation registry — and, in
//! trusted-publishers mode, only attestations attributed to a publisher the
//! wallet owner explicitly trusts.
//!
//! ## What this enforces (exact semantics — state them, don't oversell)
//!
//! Attached as a required co-signer in a signer's `SignerLimits`, or as a
//! standalone policy signer, this policy runs inside the wallet's
//! `__check_auth` and rejects the WHOLE authorization if any
//! `Context::Contract` in the invocation targets a contract that is not
//! currently attested as verified (strict mode) or not attributed to a
//! trusted publisher (trusted-publishers mode). The honest claim is
//! therefore: *a signer constrained by this policy cannot transact THROUGH
//! unverified code* — no fake-token transfers, no calls into unattested
//! contracts.
//!
//! It does NOT verify the human/classic-account recipient of funds (an x402
//! `payTo` is often a G-account with no code to verify — that is the
//! facilitator trust layer's job), and an attestation means REPRODUCIBLE,
//! ATTRIBUTABLE SOURCE PROVENANCE, not audited/benign/safe. A "warn" mode is
//! deliberately NOT a contract concern: a policy either authorizes or it
//! doesn't; warning-but-allowing is a wallet-side (pre-signing) behavior.
//!
//! ## Modes
//!
//! - [`ProvenanceMode::Strict`] — every invoked contract must hold a live
//!   attestation (`registry.is_verified`).
//! - [`ProvenanceMode::TrustedPublishers`] — every invoked contract must hold a
//!   live attestation attributed to one of the configured publisher ids
//!   (`registry.publisher_of`). The set is bounded (`MAX_TRUSTED_PUBLISHERS`)
//!   and immutable; an attestation without attribution never matches.
//!
//! ## Composition, not replacement
//!
//! This policy carries NO spending accounting. It is designed to stack with
//! the spending-limit policies via multi-policy `SignerLimits` (the smart
//! wallet iterates every required co-signer): budget caps how much, this
//! policy caps through-what. Attach both to an agent key for the full claim
//! "bounded spend, verified code only".
//!
//! ## Deny-by-default, fail-closed, bounded
//!
//! Non-contract contexts (deploys etc.) are rejected; the wallet's own admin
//! surface is never authorized; an unverified/expired/unknown contract fails
//! the whole auth; an empty context list authorizes nothing. Each context is
//! parsed explicitly: a `transfer` whose `from` is not the bound wallet is a
//! mismatched authorization context and is rejected. At most `MAX_CONTEXTS`
//! contexts are evaluated per call, with ONE registry read each — bounded
//! work, since `__check_auth` cost is consensus-priced and x402 facilitators
//! re-simulate payments. The policy holds no per-call mutable state, so
//! repeated simulation is trivially idempotent.
//!
//! ## Registry unavailable = fail closed, recover by detaching
//!
//! If the registry contract cannot be reached (archived, wrong network, or
//! simply absent) the cross-contract call traps and the authorization fails.
//! That is the intended fail-closed behavior; the RECOVERY path is the wallet
//! owner's admin passkey removing this policy signer, which the smart wallet
//! allows without consulting the policy (standalone `SignerLimits(None)`
//! attach + the wallet's sole-self-removal exception — security-audit.md V3 /
//! RA-6). This contract never blocks its own removal.
//!
//! ## Immutable configuration (deploy-once)
//!
//! Config (wallet, registry, mode) is written once in `__constructor`, no
//! setters. Repointing the registry or widening the publisher set in-place
//! would let a wallet owner void the guarantee; changing them means a fresh
//! instance and an explicit passkey-approved re-attach.
//!
//! ## Single-tenant binding
//!
//! Each instance is bound at deploy to ONE wallet; `install` and `policy__`
//! reject any other. Same TTL renewal and permissionless-self-clean behavior
//! as the sibling policies.
//!
//! ## Same-ledger revocation ordering (#591)
//!
//! Because `check_provenance` performs a synchronous cross-contract read
//! (`registry.is_verified` or `registry.publisher_of`) against persistent
//! storage rather than caching attestation state per ledger, intra-ledger
//! ordering is strictly deterministic by transaction execution position:
//! - A payment whose `__check_auth` (`policy__`) executes **before** a
//!   `registry.revoke(contract)` transaction in the same ledger observes the
//!   live attestation and is authorized.
//! - A payment whose `__check_auth` (`policy__`) executes **after**
//!   `registry.revoke(contract)` in the exact same ledger (identical ledger
//!   `sequence_number` and `timestamp`) immediately observes the deleted
//!   persistent record and fails closed with [`PolicyError::NotAllowed`].

#![no_std]

use smart_wallet_interface::{types::SignerKey, PolicyInterface, SmartWalletClient};
use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    BytesN, Env, IntoVal, Symbol, TryFromVal, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PolicyError {
    /// A context is not permitted: not a contract invocation, targets the
    /// wallet's own admin surface, or targets a contract without a live
    /// attestation in the registry.
    NotAllowed = 1,
    /// `policy__` was called for a wallet that never installed this policy.
    NotInstalled = 2,
    /// `uninstall` was called while this policy is still a signer on the wallet.
    StillInstalled = 3,
    /// Constructor was given an out-of-range configuration value (empty or
    /// oversized trusted-publisher set).
    InvalidConfig = 4,
    /// `install`/`policy__` was called by a wallet other than the one this
    /// instance was configured (bound) for at deploy time.
    WrongWallet = 5,
    /// A context invokes a contract whose live attestation is not attributed
    /// to any trusted publisher (trusted-publishers mode).
    UntrustedPublisher = 6,
    /// A transfer context's `from` argument is not the bound wallet: the
    /// authorization context does not match what this policy governs.
    ContextMismatch = 8,
    /// More auth contexts than `MAX_CONTEXTS` were supplied; the policy
    /// refuses unbounded work.
    TooManyContexts = 9,
}

/// TTL renewal parameters (in ledgers at the historical 5s close time),
/// identical to the sibling policies: bump to ~30 days whenever remaining TTL
/// drops below ~1 week.
const RENEW_THRESHOLD: u32 = 60 * 60 * 24 / 5 * 7;
const RENEW_TO: u32 = 60 * 60 * 24 / 5 * 30;

/// Upper bound on auth contexts evaluated per `policy__` call (one registry
/// read each). Shared with the spending-limit policy.
pub const MAX_CONTEXTS: u32 = 16;

/// Upper bound on the trusted-publisher set. Keeps the per-context membership
/// check O(MAX_TRUSTED_PUBLISHERS) and the instance config small.
pub const MAX_TRUSTED_PUBLISHERS: u32 = 16;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageKey {
    /// Immutable per-instance configuration, written once by the constructor.
    Config,
    /// Marker that `wallet` completed `install`.
    Installed(Address),
}

/// How the registry's answer is turned into an authorization decision.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProvenanceMode {
    /// Any contract with a live attestation passes.
    Strict,
    /// Only contracts whose live attestation is attributed to one of these
    /// publisher ids pass. 1..=`MAX_TRUSTED_PUBLISHERS` entries.
    TrustedPublishers(Vec<BytesN<32>>),
}

/// Immutable configuration set at deploy time.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    /// The single wallet this instance is bound to.
    pub wallet: Address,
    /// The attestation registry consulted for every contract the signer's
    /// auth entries invoke.
    pub registry: Address,
    /// Strict or trusted-publishers.
    pub mode: ProvenanceMode,
}

#[contract]
pub struct Contract;

#[contractimpl]
impl Contract {
    /// Deploy-time configuration. Runs exactly once (CAP-0058 constructor);
    /// wallet, registry and mode are immutable for the life of the instance.
    /// A trusted-publisher set must be non-empty and bounded.
    pub fn __constructor(env: Env, wallet: Address, registry: Address, mode: ProvenanceMode) {
        if let ProvenanceMode::TrustedPublishers(publishers) = &mode {
            if publishers.is_empty() || publishers.len() > MAX_TRUSTED_PUBLISHERS {
                panic_with_error!(&env, PolicyError::InvalidConfig);
            }
        }
        env.storage().instance().set::<StorageKey, Config>(
            &StorageKey::Config,
            &Config {
                wallet,
                registry,
                mode,
            },
        );
        renew_instance(&env);
    }

    /// Read the immutable configuration (wallet, registry, mode). No auth
    /// required.
    pub fn config(env: Env) -> Config {
        load_config(&env)
    }
}

#[contractimpl]
impl PolicyInterface for Contract {
    fn install(env: Env, wallet: Address) {
        // The wallet is the direct invoker during add_signer; invoker auth.
        wallet.require_auth();

        // Single-tenant: refuse to install on any wallet other than the bound
        // one — a hard panic aborts the wallet's add_signer cleanly.
        let config = load_config(&env);
        if wallet != config.wallet {
            panic_with_error!(&env, PolicyError::WrongWallet);
        }

        let installed_key = StorageKey::Installed(wallet);
        env.storage()
            .persistent()
            .set::<StorageKey, bool>(&installed_key, &true);

        renew_instance(&env);
        renew_persistent(&env, &installed_key);
    }

    fn uninstall(env: Env, wallet: Address) {
        // Permissionless, but only once this policy is genuinely no longer a
        // signer on `wallet` (read-only wallet view; griefers can't clear
        // state for a still-installed wallet).
        let still_signer = SmartWalletClient::new(&env, &wallet)
            .get_signer(&SignerKey::Policy(env.current_contract_address()))
            .is_some();

        if still_signer {
            panic_with_error!(&env, PolicyError::StillInstalled);
        }

        env.storage()
            .persistent()
            .remove::<StorageKey>(&StorageKey::Installed(wallet));
    }

    fn policy__(env: Env, source: Address, _signer: SignerKey, contexts: Vec<Context>) {
        // Authenticate the caller really is the wallet before touching any
        // per-wallet state. Satisfied by invoker auth during __check_auth.
        source.require_auth();

        let config = load_config(&env);

        // Single-tenant: this instance only authorizes for its bound wallet.
        if source != config.wallet {
            panic_with_error!(&env, PolicyError::WrongWallet);
        }

        let installed_key = StorageKey::Installed(source.clone());
        if !env.storage().persistent().has::<StorageKey>(&installed_key) {
            panic_with_error!(&env, PolicyError::NotInstalled);
        }

        // Bounded work: an empty authorization authorizes nothing (refuse
        // rather than rubber-stamp a vacuous auth), and an oversized one is
        // refused outright rather than iterated.
        if contexts.is_empty() {
            panic_with_error!(&env, PolicyError::NotAllowed);
        }
        if contexts.len() > MAX_CONTEXTS {
            panic_with_error!(&env, PolicyError::TooManyContexts);
        }

        // Deny-by-default over every context: only contract invocations, never
        // the wallet's own admin surface, explicitly parsed, and EVERY invoked
        // contract must satisfy the configured provenance mode. One registry
        // read per context — bounded work.
        for context in contexts.iter() {
            let contract = parse_context(&env, &source, &context);
            check_provenance(&env, &config, &contract);
        }

        // Keep this policy and its per-wallet state alive for as long as it is
        // actively authorizing.
        renew_instance(&env);
        renew_persistent(&env, &installed_key);
    }
}

/// Explicitly parse one auth context, returning the invoked contract. The
/// wallet's admin surface is never authorized. For the one function whose
/// argument semantics this policy family understands — SEP-41
/// `transfer(from, to, amount)` — `from` MUST be the bound wallet; any other
/// `from` is a mismatched context. Other functions on verified contracts are
/// permitted as invocations (this policy gates WHAT CODE is called, the
/// spending-limit policy gates HOW MUCH moves).
fn parse_context(env: &Env, source: &Address, context: &Context) -> Address {
    let Context::Contract(ContractContext {
        contract,
        fn_name,
        args,
    }) = context
    else {
        // Non-contract contexts (deploys, etc.) are never permitted.
        panic_with_error!(env, PolicyError::NotAllowed)
    };

    if *contract == *source {
        panic_with_error!(env, PolicyError::NotAllowed);
    }

    if *fn_name == symbol_short!("transfer") {
        if args.len() != 3 {
            panic_with_error!(env, PolicyError::NotAllowed);
        }
        let from = match args
            .get(0)
            .and_then(|v| Address::try_from_val(env, &v).ok())
        {
            Some(from) => from,
            None => panic_with_error!(env, PolicyError::NotAllowed),
        };
        if from != *source {
            panic_with_error!(env, PolicyError::ContextMismatch);
        }
    }

    contract.clone()
}

/// One registry read per context, interpreted per the configured mode.
fn check_provenance(env: &Env, config: &Config, contract: &Address) {
    match &config.mode {
        ProvenanceMode::Strict => {
            let verified: bool = env.invoke_contract(
                &config.registry,
                &Symbol::new(env, "is_verified"),
                Vec::from_array(env, [contract.into_val(env)]),
            );
            if !verified {
                panic_with_error!(env, PolicyError::NotAllowed);
            }
        }
        ProvenanceMode::TrustedPublishers(trusted) => {
            let publisher: Option<BytesN<32>> = env.invoke_contract(
                &config.registry,
                &Symbol::new(env, "publisher_of"),
                Vec::from_array(env, [contract.into_val(env)]),
            );
            match publisher {
                // `publisher_of` is None for unverified/expired/unattributed:
                // all three fail closed here.
                None => panic_with_error!(env, PolicyError::NotAllowed),
                Some(publisher) => {
                    if !trusted.contains(&publisher) {
                        panic_with_error!(env, PolicyError::UntrustedPublisher);
                    }
                }
            }
        }
    }
}

fn load_config(env: &Env) -> Config {
    env.storage()
        .instance()
        .get::<StorageKey, Config>(&StorageKey::Config)
        // A deployed instance always ran its constructor; fail closed rather
        // than unwrap-panic opaquely.
        .unwrap_or_else(|| panic_with_error!(env, PolicyError::NotInstalled))
}

fn renew_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(RENEW_THRESHOLD, RENEW_TO);
}

fn renew_persistent(env: &Env, key: &StorageKey) {
    env.storage()
        .persistent()
        .extend_ttl::<StorageKey>(key, RENEW_THRESHOLD, RENEW_TO);
}

#[cfg(test)]
mod test;
