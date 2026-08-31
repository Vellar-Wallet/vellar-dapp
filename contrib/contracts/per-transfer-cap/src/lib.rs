//! VELA per-transaction amount cap policy (A2): rejects any SINGLE classified
//! transfer whose amount exceeds a cap configured at deploy time in stroops.
//!
//! ## How this differs from the cumulative spending-limit policy
//!
//! These two rules answer different questions and are deliberately NOT the same
//! contract:
//!
//! | | `spending-limit` (existing) | this policy (A2) |
//! | --- | --- | --- |
//! | Question | "how much in total per window?" | "how large may ONE transfer be?" |
//! | State | persists a running `spent` total | none - every call judged fresh |
//! | Time | resets on a rolling window | no time dimension at all |
//! | Rejects | the transfer that crosses the total | the transfer that is individually too big |
//!
//! Concretely: with a cap of 10 XLM this policy permits 10 XLM now, 10 XLM a
//! second later, and 10 XLM again - each is individually within the cap. It is
//! a shape restriction on single transfers, NOT a spending limit, and it bounds
//! nothing over time. That is the intended semantic of a per-transaction cap,
//! and it is exactly why this policy is not a substitute for the cumulative
//! rolling-window allowance.
//!
//! Because `Signature::Policy` carries no secret, a per-transfer cap used ALONE
//! does not bound total loss (repeated capped transfers drain the wallet - see
//! the smart-wallet-interface `PolicyInterface` docs). Deploy this rule
//! alongside the cumulative `spending-limit` policy, or pair it with an
//! authenticated co-signer via the granting signer's `SignerLimits`, whenever a
//! bound on total outflow is required.
//!
//! ## Denominated in stroops, never fiat
//!
//! The cap is a native-unit (stroop) quantity, following the existing
//! spending-limit precedent. There is intentionally no USD/fiat option: a
//! Soroban contract has no trustless price feed, so a fiat-denominated rule
//! could only be enforced by trusting an oracle, which would make the policy's
//! guarantee only as strong as that oracle. Adding fiat support is a design
//! discussion, not a change to this rule.
//!
//! ## Deny-by-default
//!
//! Only interactions classified as a well-formed SEP-41 `transfer` are eligible
//! to pass. Anything unclassifiable - a malformed context, a non-transfer call,
//! a non-contract context, an empty context list, or a call against the
//! wallet's own admin surface - is REJECTED rather than allowed.
//!
//! ## Immutable, single-tenant configuration
//!
//! `Config` is written once by the constructor and never mutated; there is no
//! setter, because a cap the holder can raise in place guarantees nothing.
//! Each instance is bound to one wallet, and both `install` and `policy__`
//! reject any other wallet.

#![no_std]

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Env, TryFromVal, Vec,
};

/// Maximum context entries evaluated per authorization call, so the work this
/// policy performs stays bounded regardless of what the caller submits.
pub const MAX_CONTEXT_EVALUATION_LIMIT: u32 = 10;

/// A cap of zero (or less) would make the policy reject every transfer, which
/// is a configuration mistake rather than a useful rule, so it is refused at
/// construction.
const MIN_CAP_STROOPS: i128 = 1;

/// TTL renewal parameters (in ledgers at the historical 5s close time): bump to
/// ~30 days whenever remaining TTL drops below ~1 week.
const RENEW_THRESHOLD: u32 = 60 * 60 * 24 / 5 * 7;
const RENEW_TO: u32 = 60 * 60 * 24 / 5 * 30;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PolicyError {
    /// A single transfer exceeded the configured cap, or the interaction was
    /// not an allowable classified transfer (deny-by-default).
    NotAllowed = 1,
    /// `policy__` was called for a wallet that never installed this policy.
    NotInstalled = 2,
    /// Constructor was given an out-of-range cap.
    InvalidConfig = 4,
    /// Called by a wallet other than the one this instance is bound to.
    WrongWallet = 5,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageKey {
    /// Immutable per-instance configuration, written once by the constructor.
    Config,
    /// Marker that `wallet` completed `install`.
    Installed(Address),
}

/// Immutable configuration set at deploy time.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    /// The single wallet this instance is bound to.
    pub wallet: Address,
    /// Maximum amount, IN STROOPS, that any ONE transfer may move. This is not
    /// a per-window total; see the module docs.
    pub max_transfer_amount: i128,
}

/// Outcome of classifying one authorization context.
///
/// Only `Transfer` is eligible to pass the cap check; every other variant is
/// rejected, so an interaction this policy cannot understand can never be
/// silently permitted.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Interaction {
    /// A well-formed SEP-41 `transfer(from, to, amount)` with a positive amount.
    Transfer { amount: i128 },
    /// Anything this policy cannot classify as a permitted transfer.
    Unclassifiable,
}

/// Classify a single authorization context.
///
/// Returns `Transfer` only for a context that is a contract call to `transfer`
/// carrying a positive `i128` amount at the SEP-41 argument position, and whose
/// target is not the wallet's own admin surface. Everything else - a different
/// function, a missing or wrongly-typed amount, a non-positive amount, or a
/// non-contract context - is `Unclassifiable`.
pub fn classify(env: &Env, wallet: &Address, context: &Context) -> Interaction {
    match context {
        Context::Contract(ContractContext {
            contract,
            fn_name,
            args,
        }) => {
            // Never treat a call into the wallet itself (add/update/remove/
            // upgrade signer) as a spendable transfer.
            if contract == wallet {
                return Interaction::Unclassifiable;
            }

            if *fn_name != symbol_short!("transfer") {
                return Interaction::Unclassifiable;
            }

            // SEP-41 transfer(from: Address, to: Address, amount: i128).
            // A missing or non-i128 amount fails closed.
            let amount = match args.get(2).and_then(|v| i128::try_from_val(env, &v).ok()) {
                Some(amount) => amount,
                None => return Interaction::Unclassifiable,
            };

            // Zero and negative amounts are not meaningful transfers to cap.
            if amount <= 0 {
                return Interaction::Unclassifiable;
            }

            Interaction::Transfer { amount }
        }
        // Non-contract contexts (contract creation, etc.) are never transfers.
        _ => Interaction::Unclassifiable,
    }
}

#[contract]
pub struct Contract;

#[contractimpl]
impl Contract {
    /// Deploy-time configuration. Runs exactly once (CAP-0058 constructor), and
    /// there is no other path that writes `Config`, so the cap is immutable for
    /// the life of the instance.
    ///
    /// `max_transfer_amount` is IN STROOPS, matching the existing
    /// spending-limit policy. There is no fiat-denominated alternative.
    pub fn __constructor(env: Env, wallet: Address, max_transfer_amount: i128) {
        if max_transfer_amount < MIN_CAP_STROOPS {
            panic_with_error!(&env, PolicyError::InvalidConfig);
        }

        env.storage().instance().set::<StorageKey, Config>(
            &StorageKey::Config,
            &Config {
                wallet,
                max_transfer_amount,
            },
        );

        renew_instance(&env);
    }

    /// Read the immutable configuration. A read-only view; no auth required.
    pub fn config(env: Env) -> Config {
        load_config(&env)
    }

    /// Attach this policy to its bound wallet.
    pub fn install(env: Env, wallet: Address) {
        // The wallet is the direct invoker during add_signer; invoker auth.
        wallet.require_auth();

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

    /// Enforce the per-transfer cap.
    ///
    /// Every classified transfer in the invocation is checked INDIVIDUALLY
    /// against the cap. Amounts are deliberately not summed: this rule asks
    /// whether any single transfer is too large, which is a different question
    /// from the cumulative allowance enforced by the spending-limit policy.
    /// No spend state is read or written, so the decision depends only on the
    /// contexts presented.
    pub fn policy__(env: Env, source: Address, contexts: Vec<Context>) {
        // Authenticate the caller really is the wallet before doing anything
        // wallet-scoped. Satisfied by invoker auth during __check_auth.
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

        // An invocation authorizing nothing is not something to approve.
        if contexts.is_empty() {
            panic_with_error!(&env, PolicyError::NotAllowed);
        }

        // Refuse rather than silently ignore anything beyond the bound we are
        // willing to evaluate, so an over-long context list cannot smuggle an
        // unchecked transfer past the cap.
        if contexts.len() > MAX_CONTEXT_EVALUATION_LIMIT {
            panic_with_error!(&env, PolicyError::NotAllowed);
        }

        for context in contexts.iter() {
            match classify(&env, &source, &context) {
                Interaction::Transfer { amount } => {
                    // The cap comparison itself. `>` (not `>=`) makes a
                    // transfer of exactly the cap allowed.
                    if amount > config.max_transfer_amount {
                        panic_with_error!(&env, PolicyError::NotAllowed);
                    }
                }
                // Deny-by-default: anything we could not classify as a
                // permitted transfer is rejected, never allowed through.
                Interaction::Unclassifiable => {
                    panic_with_error!(&env, PolicyError::NotAllowed)
                }
            }
        }

        // Keep this policy and its install marker alive while actively used.
        renew_instance(&env);
        renew_persistent(&env, &installed_key);
    }
}

fn load_config(env: &Env) -> Config {
    env.storage()
        .instance()
        .get::<StorageKey, Config>(&StorageKey::Config)
        // A deployed instance always ran its constructor, so this is
        // unreachable in practice; fail closed rather than unwrap-panic.
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
