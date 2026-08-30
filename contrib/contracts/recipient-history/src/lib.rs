//! VELA recipient-history policy: reject transfers to addresses never seen before.
//!
//! This is a single-tenant policy bound to one wallet at deploy time. It tracks
//! which recipients have received successful transfers and, when the rule is
//! enabled, rejects any transfer to an address absent from that history.
//!
//! Recipient history is stored in a bounded persistent map. A hard cap
//! `MAX_HISTORY` (200) limits tracked recipients. When reached, the oldest
//! entry is evicted (FIFO). Entries expire after `HISTORY_TTL_SECONDS` (90 days).

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
}

const MAX_HISTORY: u32 = 200;
const HISTORY_TTL_SECONDS: u64 = 90 * 24 * 60 * 60;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageKey {
    Config,
    Installed(Address),
    History(Address, Address),
    RecipientOrder(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub wallet: Address,
}

#[contract]
pub struct Contract;

#[contractimpl]
impl Contract {
    pub fn __constructor(env: Env, wallet: Address) {
        env.storage().instance().set::<StorageKey, Config>(
            &StorageKey::Config,
            &Config { wallet },
        );
    }

    pub fn config(env: Env) -> Config {
        load_config(&env)
    }

    pub fn record_recipient(env: Env, wallet: Address, recipient: Address) {
        wallet.require_auth();
        let config = load_config(&env);
        if wallet != config.wallet {
            panic_with_error!(&env, PolicyError::WrongWallet);
        }

        let now = env.ledger().timestamp();
        let history_key = StorageKey::History(wallet.clone(), recipient.clone());
        let order_key = StorageKey::RecipientOrder(wallet.clone());

        if env.storage().persistent().has::<StorageKey>(&history_key) {
            return;
        }

        let mut order: Vec<Address> = env
            .storage()
            .persistent()
            .get::<StorageKey, Vec<Address>>(&order_key)
            .unwrap_or_else(|| Vec::new(&env));

        if order.len() >= MAX_HISTORY {
            let oldest = order.get(0).unwrap();
            let oldest_key = StorageKey::History(wallet.clone(), oldest.clone());
            env.storage()
                .persistent()
                .remove::<StorageKey>(&oldest_key);
            order.remove(0);
        }

        order.push_back(recipient.clone());
        env.storage()
            .persistent()
            .set::<StorageKey, Vec<Address>>(&order_key, &order);
        env.storage()
            .persistent()
            .set::<StorageKey, u64>(&history_key, &now);
    }

    pub fn is_known(env: Env, wallet: Address, recipient: Address) -> bool {
        let history_key = StorageKey::History(wallet, recipient);
        match env
            .storage()
            .persistent()
            .get::<StorageKey, u64>(&history_key)
        {
            Some(first_seen) => {
                let now = env.ledger().timestamp();
                now.saturating_sub(first_seen) < HISTORY_TTL_SECONDS
            }
            None => false,
        }
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

        let now = env.ledger().timestamp();

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
                        Some(v) => Address::try_from_val(&env, &v)
                            .unwrap_or_else(|_| panic_with_error!(&env, PolicyError::NotAllowed)),
                        None => panic_with_error!(&env, PolicyError::NotAllowed),
                    };

                    let history_key = StorageKey::History(source.clone(), recipient);
                    let is_known = env
                        .storage()
                        .persistent()
                        .get::<StorageKey, u64>(&history_key)
                        .map(|first_seen| now.saturating_sub(first_seen) < HISTORY_TTL_SECONDS)
                        .unwrap_or(false);

                    if !is_known {
                        panic_with_error!(&env, PolicyError::NotAllowed);
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
