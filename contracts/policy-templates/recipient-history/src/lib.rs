//! VELA recipient-history policy: reject transfers to addresses never seen before.
//!
//! This is a single-tenant policy bound to one wallet at deploy time. It tracks
//! which recipients have received successful transfers (recorded by the wallet
//! itself after a transfer succeeds) and, when the rule is enabled, rejects any
//! transfer to an address absent from that history.
//!
//! ## Storage model
//!
//! Recipient history is stored in a bounded persistent map keyed by (wallet,
//! recipient). Each entry stores the ledger sequence when it was first recorded.
//! A hard cap `MAX_HISTORY` (200) limits the number of tracked recipients. When
//! the cap is reached, the oldest entry is evicted (FIFO). This keeps storage
//! rent bounded and lookup cost O(1) per authorization.
//!
//! Entries expire after `HISTORY_TTL_SECONDS` (90 days). An expired entry is
//! treated as absent: the recipient would need to be re-introduced by a new
//! successful transfer. This is documented behaviour.

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
}

/// Maximum number of tracked recipients per wallet. When reached, the oldest
/// entry is evicted. Documented as the hard storage bound.
const MAX_HISTORY: u32 = 200;

/// Entries older than this (in seconds) are treated as absent.
const HISTORY_TTL_SECONDS: u64 = 90 * 24 * 60 * 60;

const RENEW_THRESHOLD: u32 = 60 * 60 * 24 / 5 * 7;
const RENEW_TO: u32 = 60 * 60 * 24 / 5 * 30;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageKey {
    Config,
    Installed(Address),
    /// (wallet, recipient) -> first-seen ledger timestamp.
    History(Address, Address),
    /// Ordered list of recipients for FIFO eviction.
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
        renew_instance(&env);
    }

    pub fn config(env: Env) -> Config {
        load_config(&env)
    }

    /// Record a recipient after a successful transfer. Called by the wallet.
    pub fn record_recipient(env: Env, wallet: Address, recipient: Address) {
        wallet.require_auth();
        let config = load_config(&env);
        if wallet != config.wallet {
            panic_with_error!(&env, PolicyError::WrongWallet);
        }

        let now = env.ledger().timestamp();
        let history_key = StorageKey::History(wallet.clone(), recipient.clone());
        let order_key = StorageKey::RecipientOrder(wallet.clone());

        // Already tracked — nothing to do.
        if env.storage().persistent().has::<StorageKey>(&history_key) {
            return;
        }

        // Evict oldest if at capacity.
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

        renew_persistent(&env, &order_key);
        renew_persistent(&env, &history_key);
    }

    /// Check if a recipient is in the history and not expired.
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
            .remove::<StorageKey>(&StorageKey::RecipientOrder(wallet));
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
                        Some(v) => {
                            Address::try_from_val(&env, &v).unwrap_or_else(|_| {
                                panic_with_error!(&env, PolicyError::NotAllowed)
                            })
                        }
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
