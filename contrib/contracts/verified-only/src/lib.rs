//! VELA Verified-Only Policy: Policy contract enforcing verified-only target signing.
//!
//! ## Requirements & Behavior
//!
//! - Reads the target contract address directly from protocol authorization contexts (`Context::Contract`).
//! - Queries the verification registry contract (`registry`) via cross-contract call `is_verified(target)`.
//! - Rejects authorization (`PolicyError::NotAllowed`) when the target contract is unverified or revoked in the registry.
//! - Denies by default: if the target contract address cannot be determined or if non-contract contexts are present, authorization is rejected.
//! - Enforces bounded evaluation over context entries (up to `MAX_CONTEXT_EVALUATION_LIMIT`).
//!
//! ### Scope & Limits
//!
//! Covers known direct contract invocations where the target contract address is present in the `Context::Contract`.
//! Arbitrary nested or indirect calls moving value downstream are not guaranteed to be covered and must be verified
//! individually at each boundary.

#![no_std]

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contractclient, contracterror, contractimpl, contracttype, panic_with_error,
    Address, Env, Vec,
};

pub const MAX_CONTEXT_EVALUATION_LIMIT: u32 = 10;

#[contractclient(name = "RegistryClient")]
pub trait RegistryInterface {
    fn is_verified(env: Env, target: Address) -> bool;
}

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
    pub registry: Address,
}

#[contract]
pub struct Contract;

#[contractimpl]
impl Contract {
    pub fn __constructor(env: Env, wallet: Address, registry: Address) {
        env.storage().instance().set(
            &StorageKey::Config,
            &Config { wallet, registry },
        );
    }

    pub fn config(env: Env) -> Config {
        env.storage()
            .instance()
            .get(&StorageKey::Config)
            .unwrap_or_else(|| panic_with_error!(&env, PolicyError::NotInstalled))
    }

    pub fn install(env: Env, wallet: Address) {
        wallet.require_auth();
        let config = Self::config(env.clone());
        if wallet != config.wallet {
            panic_with_error!(&env, PolicyError::WrongWallet);
        }
        env.storage()
            .persistent()
            .set(&StorageKey::Installed(wallet), &true);
    }

    pub fn policy__(env: Env, source: Address, contexts: Vec<Context>) {
        source.require_auth();
        let config = Self::config(env.clone());

        if source != config.wallet {
            panic_with_error!(&env, PolicyError::WrongWallet);
        }
        if !env
            .storage()
            .persistent()
            .has(&StorageKey::Installed(source.clone()))
        {
            panic_with_error!(&env, PolicyError::NotInstalled);
        }

        if contexts.is_empty() {
            panic_with_error!(&env, PolicyError::NotAllowed);
        }

        let registry_client = RegistryClient::new(&env, &config.registry);

        let count = contexts.len().min(MAX_CONTEXT_EVALUATION_LIMIT);
        for i in 0..count {
            let context = match contexts.get(i) {
                Some(ctx) => ctx,
                None => panic_with_error!(&env, PolicyError::NotAllowed),
            };

            match context {
                Context::Contract(ContractContext { contract, .. }) => {
                    // Do not allow calls to the wallet contract itself through verified policy
                    if contract == source {
                        panic_with_error!(&env, PolicyError::NotAllowed);
                    }

                    // Query verified registry
                    let verified = registry_client.is_verified(&contract);
                    if !verified {
                        panic_with_error!(&env, PolicyError::NotAllowed);
                    }
                }
                _ => {
                    // Deny by default for non-contract or unresolvable contexts
                    panic_with_error!(&env, PolicyError::NotAllowed);
                }
            }
        }
    }
}

#[cfg(test)]
mod test;
