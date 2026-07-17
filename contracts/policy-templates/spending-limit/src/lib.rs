//! VELA configurable spending-limit policy: a CUMULATIVE rolling-window
//! allowance whose cap and window are set PER INSTANCE at deploy time.
//!
//! This is a hardened, configurable derivative of the passkey-kit
//! `sample-policy` reference. It preserves every security invariant of that
//! reference and changes exactly one thing: the two compile-time constants
//! (`WINDOW_ALLOWANCE`, `WINDOW_SECONDS`) become immutable per-instance
//! configuration supplied to `__constructor`, so a user can choose their own
//! spending limit from the VELA policy builder and deploy an instance that
//! enforces THAT number.
//!
//! ## Why the limit is a cumulative window, not a per-transfer cap
//!
//! `Signature::Policy` carries NO secret — anyone can submit it, so a policy
//! authorizing value transfers authorizes them for EVERYONE. A per-transfer
//! cap is therefore NOT a spending limit: repeated capped transfers can move
//! the wallet's full balance (smart-wallet-interface PolicyInterface docs).
//! So the user's "daily limit" is enforced as a CUMULATIVE total over a
//! rolling window: the most anyone can move through this policy is
//! `daily_limit` per `window_seconds`. Worst-case loss is bounded to the cap.
//! For a hard guarantee that even that bounded amount requires a real
//! signature, pair this policy — via the granting signer's `SignerLimits` —
//! with an authenticated cryptographic co-signer.
//!
//! ## Immutable configuration (deploy-once)
//!
//! Config is written once in `__constructor` and NEVER mutated afterwards.
//! There is deliberately no setter: if the wallet owner could raise their own
//! cap in-place, the policy would guarantee nothing. Changing a limit means
//! deploying a fresh instance and re-attaching it with a passkey approval
//! (`kit.updatePolicy`), which is an explicit, auditable admin action.
//!
//! ## Single-tenant binding
//!
//! Each instance is bound at deploy to ONE wallet (`config.wallet`). `install`
//! and `policy__` both reject any wallet other than the bound one, so a
//! deployed instance cannot be attached to, or spent through, a different
//! wallet than the one it was configured for.
//!
//! Preserved sample-policy invariants: caller authentication
//! (`source.require_auth()` before touching per-wallet state), deny-by-default
//! (only positive `transfer`s to a non-wallet contract pass; everything else
//! fails closed), checked arithmetic, TTL renewal on install and every
//! successful check, and permissionless self-clean (`uninstall` clears state
//! only once this policy is genuinely no longer a signer on the wallet).

#![no_std]

use smart_wallet_interface::{types::SignerKey, PolicyInterface, SmartWalletClient};
use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Env, TryFromVal, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PolicyError {
    /// A context is not permitted (deny-by-default), or the cumulative
    /// window allowance would be exceeded.
    NotAllowed = 1,
    /// `policy__` was called for a wallet that never installed this policy.
    NotInstalled = 2,
    /// `uninstall` was called while this policy is still a signer on the
    /// wallet.
    StillInstalled = 3,
    /// Constructor was given an out-of-range configuration value.
    InvalidConfig = 4,
    /// `install`/`policy__` was called by a wallet other than the one this
    /// instance was configured (bound) for at deploy time.
    WrongWallet = 5,
}

/// Bounds on the configurable window. A non-positive allowance or a zero
/// window would make the policy either useless or a division-free footgun, so
/// both are rejected at construction. The window ceiling (365 days) is a
/// sanity guard — a "rolling window" longer than a year is almost certainly a
/// units mistake (e.g. passing milliseconds).
const MIN_ALLOWANCE: i128 = 1;
const MIN_WINDOW_SECONDS: u64 = 1;
const MAX_WINDOW_SECONDS: u64 = 60 * 60 * 24 * 365;

/// TTL renewal parameters (in ledgers at the historical 5s close time): bump
/// to ~30 days whenever remaining TTL drops below ~1 week. Both are well under
/// any real network's `max_ttl`. Identical to the sample-policy reference.
const RENEW_THRESHOLD: u32 = 60 * 60 * 24 / 5 * 7;
const RENEW_TO: u32 = 60 * 60 * 24 / 5 * 30;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageKey {
    /// Immutable per-instance configuration, written once by the constructor.
    Config,
    /// Marker that `wallet` completed `install`.
    Installed(Address),
    /// Per-wallet cumulative-spend accounting for the current window.
    Spend(Address),
}

/// Immutable configuration set at deploy time.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    /// The single wallet this instance is bound to.
    pub wallet: Address,
    /// Cumulative amount (in stroops) this policy authorizes per window.
    pub daily_limit: i128,
    /// Rolling-window length in seconds.
    pub window_seconds: u64,
}

/// Per-wallet cumulative-spend accounting for the current window.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Allowance {
    pub window_start: u64,
    pub spent: i128,
}

#[contract]
pub struct Contract;

#[contractimpl]
impl Contract {
    /// Deploy-time configuration. Runs exactly once (CAP-0058 constructor);
    /// there is no other path to write `Config`, so the limit and window are
    /// immutable for the life of the instance.
    ///
    /// `wallet` is the account this instance will be attached to; `install`
    /// and `policy__` reject any other wallet. `daily_limit` is the cumulative
    /// window allowance in stroops; `window_seconds` is the rolling-window
    /// length. Both are range-checked.
    pub fn __constructor(env: Env, wallet: Address, daily_limit: i128, window_seconds: u64) {
        if daily_limit < MIN_ALLOWANCE {
            panic_with_error!(&env, PolicyError::InvalidConfig);
        }
        if window_seconds < MIN_WINDOW_SECONDS || window_seconds > MAX_WINDOW_SECONDS {
            panic_with_error!(&env, PolicyError::InvalidConfig);
        }

        env.storage().instance().set::<StorageKey, Config>(
            &StorageKey::Config,
            &Config {
                wallet,
                daily_limit,
                window_seconds,
            },
        );

        renew_instance(&env);
    }

    /// Read the immutable configuration (limit, window, bound wallet). A
    /// read-only view for clients and tests; no auth required.
    pub fn config(env: Env) -> Config {
        load_config(&env)
    }
}

#[contractimpl]
impl PolicyInterface for Contract {
    fn install(env: Env, wallet: Address) {
        // The wallet is the direct invoker during add_signer; invoker auth.
        wallet.require_auth();

        // Single-tenant: refuse to install on any wallet other than the one
        // this instance was configured for. A hard panic here aborts the
        // wallet's add_signer, so a misdirected attach fails cleanly.
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
        // Permissionless: clear per-wallet state only once this policy is
        // genuinely no longer a signer on `wallet`. The wallet's get_signer is
        // a read-only view; a griefer cannot clear state for a wallet where
        // this policy is still installed.
        let still_signer = SmartWalletClient::new(&env, &wallet)
            .get_signer(&SignerKey::Policy(env.current_contract_address()))
            .is_some();

        if still_signer {
            panic_with_error!(&env, PolicyError::StillInstalled);
        }

        env.storage()
            .persistent()
            .remove::<StorageKey>(&StorageKey::Installed(wallet.clone()));
        env.storage()
            .persistent()
            .remove::<StorageKey>(&StorageKey::Spend(wallet));
    }

    fn policy__(env: Env, source: Address, _signer: SignerKey, contexts: Vec<Context>) {
        // Authenticate the caller really is the wallet before touching any
        // per-wallet state. Satisfied by invoker auth during __check_auth.
        source.require_auth();

        let config = load_config(&env);

        // Single-tenant: this instance only authorizes for its bound wallet.
        // (An external caller could pass any `source`; the require_auth above
        // stops them spending a wallet they don't control, and this stops a
        // legitimately-authed OTHER wallet from ever passing here.)
        if source != config.wallet {
            panic_with_error!(&env, PolicyError::WrongWallet);
        }

        let installed_key = StorageKey::Installed(source.clone());
        if !env.storage().persistent().has::<StorageKey>(&installed_key) {
            panic_with_error!(&env, PolicyError::NotInstalled);
        }

        // Deny-by-default. Sum the transfer amounts across all contexts in
        // this invocation; anything not explicitly permitted rejects.
        let mut total: i128 = 0;
        for context in contexts.iter() {
            match context {
                Context::Contract(ContractContext {
                    contract,
                    fn_name,
                    args,
                }) => {
                    // Never authorize the wallet's own admin surface
                    // (add/update/remove/upgrade). `source` is the wallet.
                    if contract == source {
                        panic_with_error!(&env, PolicyError::NotAllowed);
                    }

                    // Only `transfer` is permitted.
                    if fn_name != symbol_short!("transfer") {
                        panic_with_error!(&env, PolicyError::NotAllowed);
                    }

                    // Fail closed if the amount argument is missing or not an
                    // i128. (SEP-41 transfer: from, to, amount.)
                    let amount = match args.get(2).and_then(|v| i128::try_from_val(&env, &v).ok()) {
                        Some(amount) => amount,
                        None => panic_with_error!(&env, PolicyError::NotAllowed),
                    };

                    if amount <= 0 {
                        panic_with_error!(&env, PolicyError::NotAllowed);
                    }

                    total = match total.checked_add(amount) {
                        Some(total) => total,
                        None => panic_with_error!(&env, PolicyError::NotAllowed),
                    };
                }
                // Non-contract contexts (deploys, etc.) are never permitted.
                _ => panic_with_error!(&env, PolicyError::NotAllowed),
            }
        }

        // Cumulative rolling-window allowance. Load the wallet's spend record,
        // resetting it if the window has elapsed, and reject if this
        // invocation would push cumulative spend over the configured cap.
        let now = env.ledger().timestamp();
        let spend_key = StorageKey::Spend(source.clone());
        let mut allowance = env
            .storage()
            .persistent()
            .get::<StorageKey, Allowance>(&spend_key)
            .unwrap_or(Allowance {
                window_start: now,
                spent: 0,
            });

        if now.saturating_sub(allowance.window_start) >= config.window_seconds {
            allowance.window_start = now;
            allowance.spent = 0;
        }

        let new_spent = match allowance.spent.checked_add(total) {
            Some(new_spent) => new_spent,
            None => panic_with_error!(&env, PolicyError::NotAllowed),
        };

        if new_spent > config.daily_limit {
            panic_with_error!(&env, PolicyError::NotAllowed);
        }

        allowance.spent = new_spent;
        env.storage()
            .persistent()
            .set::<StorageKey, Allowance>(&spend_key, &allowance);

        // Keep this policy and its per-wallet state alive for as long as it is
        // actively authorizing.
        renew_instance(&env);
        renew_persistent(&env, &installed_key);
        renew_persistent(&env, &spend_key);
    }
}

fn load_config(env: &Env) -> Config {
    env.storage()
        .instance()
        .get::<StorageKey, Config>(&StorageKey::Config)
        // A deployed instance always ran its constructor, so this is
        // unreachable in practice; fail closed rather than unwrap-panic
        // opaquely.
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
