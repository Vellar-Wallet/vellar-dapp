//! VELA rule-composer policy: combine multiple sub-policies into a single
//! authorization hook with deny-by-default semantics and bounded iteration.
//!
//! This "meta-policy" evaluates a configured list of rule contracts. A transfer
//! is authorized only when **every** rule passes. If any rule rejects, the whole
//! authorization is rejected.
//!
//! The rule list is capped at `MAX_RULES` (10). Each rule is evaluated once.
//! Adding a future rule cannot silently make evaluation unbounded because the
//! cap is enforced centrally here.

#![no_std]

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

const MAX_RULES: u32 = 10;

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
    }

    pub fn config(env: Env) -> Config {
        load_config(&env)
    }

    pub fn install(env: Env, wallet: Address) {
        wallet.require_auth();
        let config = load_config(&env);
        if wallet != config.wallet {
            panic_with_error!(&env, PolicyError::WrongWallet);
        }

        let installed_key = StorageKey::Installed(wallet);
        env.storage()
            .persistent()
            .set::<StorageKey, bool>(&installed_key, &true);
    }

    pub fn policy__(env: Env, source: Address, contexts: Vec<Context>) {
        source.require_auth();

        let config = load_config(&env);
        if source != config.wallet {
            panic_with_error!(&env, PolicyError::WrongWallet);
        }

        let installed_key = StorageKey::Installed(source.clone());
        if !env.storage().persistent().has::<StorageKey>(&installed_key) {
            panic_with_error!(&env, PolicyError::NotInstalled);
        }

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

        for rule_addr in config.rules.iter() {
            let args: Vec<soroban_sdk::Val> = (source.clone(), contexts.clone()).into_val(&env);
            env.invoke_contract::<()>(&rule_addr, &symbol_short!("policy__"), args);
        }
    }
}

fn load_config(env: &Env) -> Config {
    env.storage()
        .instance()
        .get::<StorageKey, Config>(&StorageKey::Config)
        .unwrap_or_else(|| panic_with_error!(env, PolicyError::NotInstalled))
}

#[cfg(test)]
mod test;
