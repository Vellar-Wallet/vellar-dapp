//! M5 probe and reference for the single-signer revoke cap.
//! See docs/design-m5-threshold-attestor.md. NOT a production contract.
//!
//! One contract plays three roles, deployed several times:
//!   * the ATTESTOR: a custom account whose `__check_auth` is the thing under test;
//!   * a REGISTRY stand-in: `revoke` / `upsert` require the attestor's authorisation
//!     (like the real attestation registry's writes);
//!   * a registry that fails AFTER authorisation, and one that nests a second call,
//!     to exercise rollback and extra authorisation contexts on the real host.
//!
//! `Sig::Mode` is the protocol canary: which write may `__check_auth` perform on the
//! host? `Sig::Single(i)` / `Sig::Pair` stand in for "one verified signature from signer
//! `i`" / "two verified signatures". NO signatures are checked here; the real attestor
//! verifies them first and then applies exactly the rules below.
#![no_std]

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl, contracttype,
    crypto::Hash,
    panic_with_error, symbol_short, Address, Env, FromVal, Symbol, Vec,
};

/// Single-signature revokes allowed per signer inside one window.
pub const CAP: u32 = 3;
/// The window, in ledgers (about 24 hours at ~5s per ledger).
pub const WINDOW_LEDGERS: u32 = 17_280;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ProbeError {
    Denied = 1,
    /// The signer already used its allowance in the window.
    CapReached = 2,
    /// Not exactly one `revoke(this account, record)` on the bound registry.
    WrongContext = 3,
    /// No registry is bound to this account.
    NotBound = 4,
    /// A registry stand-in failing on purpose, after authorisation succeeded.
    RegistryFailed = 5,
}

#[contracttype]
#[derive(Clone)]
pub enum Key {
    Registry,
    FailAfterAuth,
    NestInto,
    Counter,
    Persisted,
    /// Ledgers of this signer's recent single-signature revokes.
    Ring(u32),
    Revoked(Address),
}

#[contracttype]
#[derive(Clone)]
pub enum Sig {
    /// Protocol canary: which write does `__check_auth` attempt (see `write_canary`).
    Mode(u32),
    /// One verified signature, from signer `index`.
    Single(u32),
    /// Two verified signatures (the attest threshold).
    Pair,
}

#[contract]
pub struct Probe;

#[contractimpl]
impl Probe {
    pub fn __constructor(
        env: Env,
        registry: Option<Address>,
        fail_after_auth: bool,
        nest_into: Option<Address>,
    ) {
        if let Some(r) = registry {
            env.storage().instance().set(&Key::Registry, &r);
        }
        env.storage()
            .instance()
            .set(&Key::FailAfterAuth, &fail_after_auth);
        if let Some(n) = nest_into {
            env.storage().instance().set(&Key::NestInto, &n);
        }
    }

    /// Requires this account's own authorisation, which runs `__check_auth`.
    pub fn ping(env: Env) {
        env.current_contract_address().require_auth();
    }

    /// Registry stand-in for `revoke`. Authorised by `attestor`, then optionally
    /// nests a second authorised call (an extra context) and/or fails (rollback).
    pub fn revoke(env: Env, attestor: Address, record: Address) {
        attestor.require_auth();
        if let Some(inner) = env.storage().instance().get::<Key, Address>(&Key::NestInto) {
            ProbeClient::new(&env, &inner).revoke(&attestor, &record);
        }
        if env
            .storage()
            .instance()
            .get::<Key, bool>(&Key::FailAfterAuth)
            .unwrap_or(false)
        {
            panic_with_error!(&env, ProbeError::RegistryFailed);
        }
        env.storage().persistent().set(&Key::Revoked(record), &true);
    }

    /// Registry stand-in for a different write (`upsert`).
    pub fn upsert(env: Env, attestor: Address, record: Address) {
        attestor.require_auth();
        env.storage()
            .persistent()
            .set(&Key::Revoked(record), &false);
    }

    pub fn counter(env: Env) -> u32 {
        env.storage().instance().get(&Key::Counter).unwrap_or(0)
    }
    pub fn persisted(env: Env) -> u32 {
        env.storage().persistent().get(&Key::Persisted).unwrap_or(0)
    }
    /// The ledgers recorded for `signer`'s single-signature revokes.
    pub fn ring(env: Env, signer: u32) -> Vec<u32> {
        env.storage()
            .instance()
            .get(&Key::Ring(signer))
            .unwrap_or(Vec::new(&env))
    }
    pub fn revoked(env: Env, record: Address) -> bool {
        env.storage()
            .persistent()
            .get(&Key::Revoked(record))
            .unwrap_or(false)
    }
}

#[contractimpl]
impl CustomAccountInterface for Probe {
    type Signature = Sig;
    type Error = ProbeError;

    fn __check_auth(
        env: Env,
        _payload: Hash<32>,
        sig: Sig,
        contexts: Vec<Context>,
    ) -> Result<(), ProbeError> {
        match sig {
            Sig::Mode(mode) => write_canary(&env, mode),
            // Two verified signatures: any context, and NO signer's allowance is touched.
            Sig::Pair => Ok(()),
            Sig::Single(signer) => single_signer_revoke(&env, signer, &contexts),
        }
    }
}

/// The protocol canary. Each mode attempts one thing `__check_auth` might not be
/// allowed to do on the real host.
fn write_canary(env: &Env, mode: u32) -> Result<(), ProbeError> {
    match mode {
        0 => {} // control: no write at all
        1 => {
            let n: u32 = env.storage().instance().get(&Key::Counter).unwrap_or(0);
            env.storage().instance().set(&Key::Counter, &(n + 1));
        }
        2 => env.storage().persistent().set(&Key::Persisted, &1u32),
        // A REAL extension: the current TTL is far below the threshold.
        3 => env.storage().instance().extend_ttl(1_000_000, 2_000_000),
        4 => env.events().publish((symbol_short!("probe"),), mode),
        5 => {
            let _: u32 = env.storage().instance().get(&Key::Counter).unwrap_or(0);
        }
        _ => return Err(ProbeError::Denied),
    }
    Ok(())
}

/// Accept ONE signature only for exactly one `revoke(this account, record)` on the
/// bound registry, and only while the signer is under its cap. Nothing is written
/// unless every check passes, so a refusal never touches a counter.
fn single_signer_revoke(env: &Env, signer: u32, contexts: &Vec<Context>) -> Result<(), ProbeError> {
    let registry: Address = env
        .storage()
        .instance()
        .get(&Key::Registry)
        .ok_or(ProbeError::NotBound)?;

    // Exactly one context. A second call anywhere in the authorised tree refuses.
    if contexts.len() != 1 {
        return Err(ProbeError::WrongContext);
    }
    match contexts.get(0).unwrap() {
        Context::Contract(c) => {
            if c.contract != registry
                || c.fn_name != Symbol::new(env, "revoke")
                || c.args.len() != 2
            {
                return Err(ProbeError::WrongContext);
            }
            // The first argument is the account being authorised: this one.
            let who = Address::from_val(env, &c.args.get(0).unwrap());
            if who != env.current_contract_address() {
                return Err(ProbeError::WrongContext);
            }
        }
        _ => return Err(ProbeError::WrongContext),
    }

    let now = env.ledger().sequence();
    let key = Key::Ring(signer);
    let ring: Vec<u32> = env.storage().instance().get(&key).unwrap_or(Vec::new(env));
    let mut recent: Vec<u32> = Vec::new(env);
    for ledger in ring.iter() {
        // Still inside the window while younger than WINDOW_LEDGERS ledgers.
        if now.saturating_sub(ledger) < WINDOW_LEDGERS {
            recent.push_back(ledger);
        }
    }
    if recent.len() >= CAP {
        return Err(ProbeError::CapReached);
    }
    recent.push_back(now);
    env.storage().instance().set(&key, &recent);
    Ok(())
}

#[cfg(test)]
mod test;
