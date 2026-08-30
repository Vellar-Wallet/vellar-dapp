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
    NotAllowed = 1,
    NotInstalled = 2,
    StillInstalled = 3,
    InvalidConfig = 4,
    WrongWallet = 5,
    ListFull = 6,
    NotInList = 7,
    Unauthorized = 8,
}

/// Hard upper bound on list size. Keeps the authorization scan O(1)-bounded
/// (max 50 iterations) and limits persistent storage rent.
const MAX_RECIPIENTS: u32 = 50;

/// TTL renewal constants (ledgers at ~5 s close).
const RENEW_THRESHOLD: u32 = 60 * 60 * 24 / 5 * 7;
const RENEW_TO: u32 = 60 * 60 * 24 / 5 * 30;

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
    /// Deploy-time configuration. `wallet` is the single account this instance
    /// serves; `mode` controls allow vs block semantics.
    pub fn __constructor(env: Env, wallet: Address, mode: RecipientMode) {
        env.storage().instance().set::<StorageKey, Config>(
            &StorageKey::Config,
            &Config { wallet, mode },
        );
        renew_instance(&env);
    }

    pub fn config(env: Env) -> Config {
        load_config(&env)
    }

    /// Add a recipient to the list. Requires wallet authorization.
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

        // Reject duplicates.
        if list.iter().any(|a| a == recipient) {
            return; // idempotent
        }

        list.push_back(recipient);
        env.storage()
            .persistent()
            .set::<StorageKey, Vec<Address>>(&list_key, &list);

        renew_persistent(&env, &list_key);
    }

    /// Remove a recipient from the list. Requires wallet authorization.
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

        // Find and remove.
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

    /// Read the current list (read-only view).
    pub fn get_list(env: Env, wallet: Address) -> Vec<Address> {
        let list_key = StorageKey::List(wallet);
        env.storage()
            .persistent()
            .get::<StorageKey, Vec<Address>>(&list_key)
            .unwrap_or_else(|| Vec::new(&env))
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
            .remove::<StorageKey>(&StorageKey::Installed(wallet.clone()));
        env.storage()
            .persistent()
            .remove::<StorageKey>(&StorageKey::List(wallet));
    }

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
                    // Never authorize admin surface.
                    if contract == source {
                        panic_with_error!(&env, PolicyError::NotAllowed);
                    }

                    if fn_name != symbol_short!("transfer") {
                        panic_with_error!(&env, PolicyError::NotAllowed);
                    }

                    // SEP-41 transfer: from, to, amount. Extract recipient.
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
