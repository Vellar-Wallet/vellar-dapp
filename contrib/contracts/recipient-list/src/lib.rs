//! VELA recipient-list policy: allow or deny transfers to specific recipients.
//!
//! This is a single-tenant policy bound to one wallet at deploy time. It stores
//! a bounded list of recipient addresses and a mode (Allow or Block). During
//! authorization, each classified transfer is checked against the list:
//!
//! - **Allow mode**: Only transfers to listed recipients pass; all others reject.
//! - **Block mode**: Transfers to listed recipients reject; all others pass.
//!
//! The list is mutable at runtime via `add_recipient` / `remove_recipient`,
//! both gated behind the wallet's own authorization (require_auth). A hard cap
//! `MAX_RECIPIENTS` (50) bounds storage growth and keeps the authorization path
//! predictably cheap.

#![no_std]

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Env, TryFromVal, Vec,
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
    ListFull = 6,
    NotInList = 7,
    Unauthorized = 8,
}

const MAX_RECIPIENTS: u32 = 50;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageKey {
    Config,
    Installed(Address),
    List(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecipientMode {
    Allow,
    Block,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub wallet: Address,
    pub mode: RecipientMode,
}

#[contract]
pub struct Contract;

#[contractimpl]
impl Contract {
    pub fn __constructor(env: Env, wallet: Address, mode: RecipientMode) {
        env.storage().instance().set::<StorageKey, Config>(
            &StorageKey::Config,
            &Config { wallet, mode },
        );
    }

    pub fn config(env: Env) -> Config {
        load_config(&env)
    }

    pub fn add_recipient(env: Env, wallet: Address, recipient: Address) {
        wallet.require_auth();

        let config = load_config(&env);
        if wallet != config.wallet {
            panic_with_error!(&env, PolicyError::WrongWallet);
        }

        let list_key = StorageKey::List(wallet.clone());
        let mut list: Vec<Address> = env
            .storage()
            .persistent()
            .get::<StorageKey, Vec<Address>>(&list_key)
            .unwrap_or_else(|| Vec::new(&env));

        if list.len() >= MAX_RECIPIENTS {
            panic_with_error!(&env, PolicyError::ListFull);
        }

        if list.iter().any(|a| a == recipient) {
            return;
        }

        list.push_back(recipient);
        env.storage()
            .persistent()
            .set::<StorageKey, Vec<Address>>(&list_key, &list);
    }

    pub fn remove_recipient(env: Env, wallet: Address, recipient: Address) {
        wallet.require_auth();

        let config = load_config(&env);
        if wallet != config.wallet {
            panic_with_error!(&env, PolicyError::WrongWallet);
        }

        let list_key = StorageKey::List(wallet.clone());
        let list: Vec<Address> = env
            .storage()
            .persistent()
            .get::<StorageKey, Vec<Address>>(&list_key)
            .unwrap_or_else(|| Vec::new(&env));

        let mut new_list = Vec::new(&env);
        let mut found = false;
        for a in list.iter() {
            if a == recipient {
                found = true;
            } else {
                new_list.push_back(a);
            }
        }

        if !found {
            panic_with_error!(&env, PolicyError::NotInList);
        }

        env.storage()
            .persistent()
            .set::<StorageKey, Vec<Address>>(&list_key, &new_list);
    }

    pub fn get_list(env: Env, wallet: Address) -> Vec<Address> {
        let list_key = StorageKey::List(wallet);
        env.storage()
            .persistent()
            .get::<StorageKey, Vec<Address>>(&list_key)
            .unwrap_or_else(|| Vec::new(&env))
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

        let list_key = StorageKey::List(source.clone());
        let list: Vec<Address> = env
            .storage()
            .persistent()
            .get::<StorageKey, Vec<Address>>(&list_key)
            .unwrap_or_else(|| Vec::new(&env));

        for context in contexts.iter() {
            match context {
                Context::Contract(ContractContext {
                    contract,
                    fn_name,
                    args,
                }) => {
                    if contract == source {
                        panic_with_error!(&env, PolicyError::NotAllowed);
                    }

                    if fn_name != symbol_short!("transfer") {
                        panic_with_error!(&env, PolicyError::NotAllowed);
                    }

                    let recipient = match args.get(1) {
                        Some(v) => Address::try_from_val(&env, &v).unwrap_or_else(|_| {
                            panic_with_error!(&env, PolicyError::NotAllowed)
                        }),
                        None => panic_with_error!(&env, PolicyError::NotAllowed),
                    };

                    let in_list = list.iter().any(|a| a == recipient);

                    match config.mode {
                        RecipientMode::Allow => {
                            if !in_list {
                                panic_with_error!(&env, PolicyError::NotAllowed);
                            }
                        }
                        RecipientMode::Block => {
                            if in_list {
                                panic_with_error!(&env, PolicyError::NotAllowed);
                            }
                        }
                    }
                }
                _ => panic_with_error!(&env, PolicyError::NotAllowed),
            }
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
