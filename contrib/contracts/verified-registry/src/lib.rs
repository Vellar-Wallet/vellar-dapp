#![no_std]
#![allow(deprecated)]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address, BytesN, Env, Symbol};

/// TTL renewal parameters (in ledgers at the historical 5s close time): bump
/// to ~30 days whenever remaining TTL drops below ~1 week.
const RENEW_THRESHOLD: u32 = 60 * 60 * 24 / 5 * 7;
const RENEW_TO: u32 = 60 * 60 * 24 / 5 * 30;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum RegistryError {
    /// The caller is not the configured admin address.
    NotAuthorized = 1,
    /// The wasm hash is already in the registry.
    AlreadyVerified = 2,
    /// The wasm hash was not found in the registry and cannot be removed.
    NotVerified = 3,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageKey {
    /// The single admin address, written once by the constructor.
    Admin,
    /// Per-wasm-hash marker. Keyed by the wasm hash bytes directly so lookup
    /// is a single persistent read. The entry value records when it was added.
    Verified(BytesN<32>),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedEntry {
    pub added_at: u64,
}

fn load_admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get::<StorageKey, Address>(&StorageKey::Admin)
        .unwrap_or_else(|| panic_with_error!(env, RegistryError::NotAuthorized))
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

const EVENT_ADD: Symbol = symbol_short!("add");
const EVENT_REMOVE: Symbol = symbol_short!("rmv");

#[contract]
pub struct VerifiedRegistry;

#[contractimpl]
impl VerifiedRegistry {
    /// Initialise the registry with a single administrative address.
    /// Only `admin` may add or remove verified wasm hashes afterward.
    pub fn __constructor(env: Env, admin: Address) {
        env.storage()
            .instance()
            .set::<StorageKey, Address>(&StorageKey::Admin, &admin);
        renew_instance(&env);
    }

    /// Mark a wasm hash as verified.
    ///
    /// Emits an `add` event with topic `(add, admin, wasm_hash)` and
    /// payload `VerifiedEntry { added_at }`.
    ///
    /// ## Storage choice
    /// Each entry uses a separate `persistent` key so lookup by wasm hash is
    /// a single O(1) read — no scanning. The admin address lives in `instance`
    /// storage because it is written once and never updated. `persistent`
    /// entries require explicit TTL extension; we bump to ~30 days on every
    /// write, so an actively maintained registry stays live. A registry that
    /// stops being maintained will see entries expire silently — the contract
    /// does not prevent this because there is no periodic keeper.
    pub fn add(env: Env, wasm_hash: BytesN<32>) {
        let admin = load_admin(&env);
        admin.require_auth();

        let key = StorageKey::Verified(wasm_hash.clone());
        if env.storage().persistent().has::<StorageKey>(&key) {
            panic_with_error!(&env, RegistryError::AlreadyVerified);
        }

        let entry = VerifiedEntry {
            added_at: env.ledger().timestamp(),
        };
        env.storage()
            .persistent()
            .set::<StorageKey, VerifiedEntry>(&key, &entry);
        renew_persistent(&env, &key);
        renew_instance(&env);

        env.events().publish(
            (EVENT_ADD, admin, wasm_hash),
            entry,
        );
    }

    /// Remove a wasm hash from the registry so it is no longer treated as
    /// verified.
    ///
    /// Emits a `rmv` event with topic `(rmv, admin, wasm_hash)` and an
    /// empty payload.
    pub fn remove(env: Env, wasm_hash: BytesN<32>) {
        let admin = load_admin(&env);
        admin.require_auth();

        let key = StorageKey::Verified(wasm_hash.clone());
        if !env.storage().persistent().has::<StorageKey>(&key) {
            panic_with_error!(&env, RegistryError::NotVerified);
        }

        env.storage()
            .persistent()
            .remove::<StorageKey>(&key);

        env.events().publish(
            (EVENT_REMOVE, admin, wasm_hash),
            (),
        );
    }
}

#[cfg(test)]
mod test;
