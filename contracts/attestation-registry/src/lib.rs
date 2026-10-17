//! VELA attestation registry: the on-chain mirror of the OFF-CHAIN contract
//! verification pipeline, consumed by the verified-recipient policy.
//!
//! ## What this is (and is honestly not)
//!
//! Verification truth lives off-chain — a contract cannot rebuild another
//! contract's source on-chain. This registry is therefore an ORACLE, scoped as
//! narrowly as possible: a single attestor key (held by the verification
//! service) writes time-bounded records of "contract X currently has verified
//! source with wasm hash H". `is_verified` is the one-read view a policy calls
//! inside `__check_auth`.
//!
//! An attestation means REPRODUCIBLE, ATTRIBUTABLE SOURCE PROVENANCE — it does
//! NOT mean audited, benign, or safe. Every consumer of this registry must
//! carry that framing.
//!
//! ## Fail-closed by expiry (silence decays to unverified)
//!
//! Every attestation carries an `expires_ledger`. `is_verified` returns true
//! only while the current ledger is strictly below it, so a verification
//! service that stops re-attesting — or a contract whose re-verification
//! fails — decays to unverified WITHOUT anyone needing to call `revoke`.
//! Revocation exists for the fast path (the attestor sees an upgrade or a
//! failed rebuild and kills the attestation immediately); expiry is the
//! backstop that needs no one's liveness.
//!
//! ## Known limit: upgrade staleness (TOCTOU)
//!
//! Soroban gives contracts no host function to read another contract's current
//! executable wasm hash, so this registry cannot self-check that an attested
//! contract still runs the attested code. A contract upgraded after
//! attestation stays "verified" until the attestor revokes or the record
//! expires. Mitigation is layered off-chain (short expiries, the attestor's
//! upgrade watch, facilitator-side live hash checks at payment time) and the
//! residual window is DOCUMENTED wherever enforcement is claimed — never
//! hidden. The attested `wasm_hash` is stored so off-chain consumers can
//! compare it against the live hash themselves.
//!
//! ## No user funds, no user state
//!
//! The registry holds no funds and stores nothing per-user: one instance-level
//! attestor address, one persistent record per attested contract. Worst-case
//! compromise of the attestor key mis-labels provenance; it cannot move value.
//! The attestor is rotatable (`set_attestor`) by the current attestor.
//!
//! ## Publisher attribution (trusted-publishers policy mode)
//!
//! An attestation may carry a `publisher` id: a 32-byte identifier of WHO the
//! verified source is attributed to, derived off-chain by the attestor from the
//! verification record's canonical source location (e.g. `sha256` of the
//! lower-cased `github.com/<owner>`). The verified-recipient policy's
//! trusted-publishers mode consults it through `publisher_of`, which answers
//! only while the attestation is live — provenance and attribution expire
//! together. `upsert` (no publisher) is kept for attestors that cannot
//! attribute; such attestations are verified but unattributed and never match
//! a trusted-publisher set (deny-by-default).

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    BytesN, Env,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum RegistryError {
    /// `upsert` was given an expiry not strictly in the future, or further out
    /// than the maximum attestation lifetime.
    InvalidExpiry = 1,
    /// The instance was somehow used before its constructor ran. Unreachable on
    /// a properly deployed instance; fail closed rather than unwrap opaquely.
    NotInitialized = 2,
}

/// Attestations may not be issued further ahead than ~1 year of ledgers (at the
/// historical 5s close time). The verification service issues far shorter ones
/// (days); this cap is a sanity guard against a fat-fingered expiry.
const MAX_ATTESTATION_LEDGERS: u32 = 60 * 60 * 24 * 365 / 5;

/// Instance TTL renewal parameters, identical to the policy contracts: bump to
/// ~30 days whenever remaining TTL drops below ~1 week.
const RENEW_THRESHOLD: u32 = 60 * 60 * 24 / 5 * 7;
const RENEW_TO: u32 = 60 * 60 * 24 / 5 * 30;

/// Extra ledgers of storage TTL beyond an attestation's logical expiry, so a
/// record never becomes unreadable (archived) while still logically live.
const TTL_BUFFER: u32 = 60 * 60 * 24 / 5 * 7;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageKey {
    /// The single address allowed to write attestations. Instance storage.
    Attestor,
    /// Per-contract attestation record. Persistent storage.
    Attestation(Address),
}

/// A time-bounded statement that `contract` had verified (reproducible) source
/// with executable hash `wasm_hash` when attested.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Attestation {
    /// The wasm hash the verification pipeline reproduced byte-for-byte at
    /// attestation time. Off-chain consumers compare this against the live
    /// on-chain hash to detect post-attestation upgrades.
    pub wasm_hash: BytesN<32>,
    /// Ledger sequence at which the attestation was written.
    pub attested_ledger: u32,
    /// First ledger at which this attestation is no longer valid.
    pub expires_ledger: u32,
    /// Off-chain-derived publisher identifier the verified source is attributed
    /// to, if the attestor supplied one. `None` = verified but unattributed.
    pub publisher: Option<BytesN<32>>,
}

/// Event payload emitted on every attestation write (`upsert` and
/// `upsert_with_publisher`) so off-chain indexers can subscribe incrementally
/// instead of scanning persistent contract storage.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttestationWriteEvent {
    /// Contract address whose verification status was attested.
    pub contract: Address,
    /// Reproduced WASM hash recorded for `contract`.
    pub wasm_hash: BytesN<32>,
    /// Ledger sequence at which the attestation was written.
    pub attested_ledger: u32,
    /// First ledger sequence at which this attestation expires.
    pub expires_ledger: u32,
    /// Optional publisher attribution identifier.
    pub publisher: Option<BytesN<32>>,
}

#[contract]
pub struct Contract;

#[contractimpl]
impl Contract {
    /// Deploy-time configuration: the attestor address (the verification
    /// service's key). Runs exactly once; rotation afterwards goes through
    /// `set_attestor` under the current attestor's auth.
    pub fn __constructor(env: Env, attestor: Address) {
        env.storage()
            .instance()
            .set::<StorageKey, Address>(&StorageKey::Attestor, &attestor);
        renew_instance(&env);
    }

    /// Write or refresh the attestation for `contract`. Attestor-only.
    ///
    /// `expires_ledger` must be strictly in the future and within the maximum
    /// attestation lifetime. Storage TTL is extended to outlive the logical
    /// expiry, so a live attestation can never be archived out from under a
    /// reader.
    pub fn upsert(env: Env, contract: Address, wasm_hash: BytesN<32>, expires_ledger: u32) {
        write_attestation(&env, contract, wasm_hash, expires_ledger, None);
    }

    /// Write or refresh the attestation for `contract` WITH publisher
    /// attribution. Attestor-only; same expiry rules as `upsert`. Replaces any
    /// prior (attributed or not) attestation for the contract.
    pub fn upsert_with_publisher(
        env: Env,
        contract: Address,
        wasm_hash: BytesN<32>,
        publisher: BytesN<32>,
        expires_ledger: u32,
    ) {
        write_attestation(&env, contract, wasm_hash, expires_ledger, Some(publisher));
    }

    /// Remove the attestation for `contract` immediately. Attestor-only.
    /// Idempotent: revoking a contract with no live attestation is a no-op, so
    /// the attestor's revoke-on-upgrade watch never races itself into errors.
    pub fn revoke(env: Env, contract: Address) {
        load_attestor(&env).require_auth();

        env.storage()
            .persistent()
            .remove::<StorageKey>(&StorageKey::Attestation(contract.clone()));
        renew_instance(&env);

        env.events()
            .publish((symbol_short!("revoke"), contract), ());
    }

    /// Rotate the attestor key. Current-attestor auth.
    pub fn set_attestor(env: Env, new_attestor: Address) {
        load_attestor(&env).require_auth();

        env.storage()
            .instance()
            .set::<StorageKey, Address>(&StorageKey::Attestor, &new_attestor);
        renew_instance(&env);

        env.events()
            .publish((symbol_short!("attestor"),), new_attestor);
    }

    /// THE consumer view: is `contract` currently attested as verified? One
    /// persistent read + a ledger-sequence compare — deliberately cheap, since
    /// the verified-recipient policy calls this inside `__check_auth` where
    /// work must stay bounded. No auth required.
    pub fn is_verified(env: Env, contract: Address) -> bool {
        match env
            .storage()
            .persistent()
            .get::<StorageKey, Attestation>(&StorageKey::Attestation(contract))
        {
            Some(attestation) => env.ledger().sequence() < attestation.expires_ledger,
            None => false,
        }
    }

    /// The publisher a LIVE attestation for `contract` is attributed to, or
    /// `None` when the contract is unverified, its attestation has expired, or
    /// it was attested without attribution. One persistent read + a ledger
    /// compare — the trusted-publishers policy mode calls this inside
    /// `__check_auth`, so it stays as cheap as `is_verified`. No auth required.
    pub fn publisher_of(env: Env, contract: Address) -> Option<BytesN<32>> {
        match env
            .storage()
            .persistent()
            .get::<StorageKey, Attestation>(&StorageKey::Attestation(contract))
        {
            Some(attestation) if env.ledger().sequence() < attestation.expires_ledger => {
                attestation.publisher
            }
            _ => None,
        }
    }

    /// Full attestation record for `contract`, if one exists (live OR logically
    /// expired-but-unarchived). Read-only view for off-chain consumers that
    /// want the attested wasm hash to compare against the live one; on-chain
    /// consumers should use `is_verified`.
    pub fn attestation(env: Env, contract: Address) -> Option<Attestation> {
        env.storage()
            .persistent()
            .get::<StorageKey, Attestation>(&StorageKey::Attestation(contract))
    }

    /// The current attestor address. Read-only view.
    pub fn attestor(env: Env) -> Address {
        load_attestor(&env)
    }
}

fn write_attestation(
    env: &Env,
    contract: Address,
    wasm_hash: BytesN<32>,
    expires_ledger: u32,
    publisher: Option<BytesN<32>>,
) {
    load_attestor(env).require_auth();

    let now = env.ledger().sequence();
    if expires_ledger <= now || expires_ledger - now > MAX_ATTESTATION_LEDGERS {
        panic_with_error!(env, RegistryError::InvalidExpiry);
    }

    let key = StorageKey::Attestation(contract.clone());
    env.storage().persistent().set::<StorageKey, Attestation>(
        &key,
        &Attestation {
            wasm_hash: wasm_hash.clone(),
            attested_ledger: now,
            expires_ledger,
            publisher: publisher.clone(),
        },
    );

    // Keep the record readable for at least its logical lifetime + buffer.
    let live_for = expires_ledger - now + TTL_BUFFER;
    env.storage()
        .persistent()
        .extend_ttl::<StorageKey>(&key, live_for, live_for);
    renew_instance(env);

    env.events().publish(
        (symbol_short!("attest"), contract.clone()),
        AttestationWriteEvent {
            contract,
            wasm_hash,
            attested_ledger: now,
            expires_ledger,
            publisher,
        },
    );
}

fn load_attestor(env: &Env) -> Address {
    env.storage()
        .instance()
        .get::<StorageKey, Address>(&StorageKey::Attestor)
        .unwrap_or_else(|| panic_with_error!(env, RegistryError::NotInitialized))
}

fn renew_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(RENEW_THRESHOLD, RENEW_TO);
}

#[cfg(test)]
mod test;
