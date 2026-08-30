//! VELA rule-composer policy: combine multiple sub-policies into a single
//! authorization hook with deny-by-default semantics and bounded iteration.
//!
//! This is the "meta-policy" that evaluates a configured list of rule
//! contracts. A transfer is authorized only when **every** rule passes. If any
//! rule rejects, the whole authorization is rejected. Unclassifiable
//! interactions are also rejected (deny-by-default).
//!
//! ## Bounded work
//!
//! The rule list is capped at `MAX_RULES` (10). Each rule is evaluated once.
//! Adding a future rule cannot silently make evaluation unbounded because the
//! cap is enforced centrally here, not per-rule.
//!
//! ## Configuration
//!
//! The list of rule contract addresses is set at construction time and is
//! immutable (deploy-once pattern, same as spending-limit). Changing the rule
//! set means deploying a fresh composer instance.

#![no_std]

use smart_wallet_interface::{types::SignerKey, PolicyInterface, SmartWalletClient};
use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Env, IntoVal, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PolicyError {
    NotAllowed = 1,
    NotInstalled = 2,
    StillInstalled = 3,
    InvalidConfig = 4,
    WrongWallet = 5,
}

/// Hard upper bound on the number of rules. Enforced centrally so future rules
/// cannot silently grow the evaluation loop.
const MAX_RULES: u32 = 10;

const RENEW_THRESHOLD: u32 = 60 * 60 * 24 / 5 * 7;
const RENEW_TO: u32 = 60 * 60 * 24 / 5 * 30;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageKey {
    Config,
    Installed(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub wallet: Address,
    /// Rule contract addresses, evaluated in order. Each must implement
    /// `PolicyInterface`. A transfer passes only when every rule's `policy__`
    /// succeeds.
    pub rules: Vec<Address>,
}

#[contract]
pub struct Contract;

#[contractimpl]
impl Contract {
    pub fn __constructor(env: Env, wallet: Address, rules: Vec<Address>) {
        if rules.len() > MAX_RULES {
            panic_with_error!(&env, PolicyError::InvalidConfig);
        }

        env.storage().instance().set::<StorageKey, Config>(
            &StorageKey::Config,
            &Config { wallet, rules },
        );
        renew_instance(&env);
    }

    pub fn config(env: Env) -> Config {
        load_config(&env)
    }
}

#[contractimpl]
impl PolicyInterface for Contract {
    fn install(env: Env, wallet: Address) {
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

    fn uninstall(env: Env, wallet: Address) {
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

    /// Evaluate all configured rules. A transfer is authorized only when every
    /// rule's `policy__` call succeeds. Non-transfer contexts are always
    /// rejected (deny-by-default).
    fn policy__(env: Env, source: Address, _signer: SignerKey, contexts: Vec<Context>) {
        source.require_auth();

        let config = load_config(&env);
        if source != config.wallet {
            panic_with_error!(&env, PolicyError::WrongWallet);
        }

        let installed_key = StorageKey::Installed(source.clone());
        if !env.storage().persistent().has::<StorageKey>(&installed_key) {
            panic_with_error!(&env, PolicyError::NotInstalled);
        }

        // Deny-by-default: only transfer contexts to non-wallet contracts pass.
        for context in contexts.iter() {
            match context {
                Context::Contract(ContractContext {
                    contract,
                    fn_name,
                    ..
                }) => {
                    if contract == source {
                        panic_with_error!(&env, PolicyError::NotAllowed);
                    }
                    if fn_name != symbol_short!("transfer") {
                        panic_with_error!(&env, PolicyError::NotAllowed);
                    }
                }
                _ => panic_with_error!(&env, PolicyError::NotAllowed),
            }
        }

        // Evaluate every rule. Each rule's policy__ is called with the same
        // source, signer, and contexts. If ANY rule rejects (panics), the
        // whole authorization is rejected because we don't catch panics.
        // This is the deny-by-default composition: all must pass.
        for rule_addr in config.rules.iter() {
            // We call each rule contract's policy__ via the Soroban host.
            // The rule contract is expected to implement PolicyInterface.
            // A panic inside the rule propagates here and rejects the auth.
            let args: Vec<soroban_sdk::Val> = (
                source.clone(),
                SignerKey::Policy(rule_addr.clone()),
                contexts.clone(),
            )
                .into_val(&env);
            env.invoke_contract::<()>(&rule_addr, &symbol_short!("policy__"), args);
        }

        renew_instance(&env);
        renew_persistent(&env, &installed_key);
    }
}

fn load_config(env: &Env) -> Config {
    env.storage()
        .instance()
        .get::<StorageKey, Config>(&StorageKey::Config)
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
