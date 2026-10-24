#![cfg(test)]

//! Tests for the attestation registry.
//!
//! Auth model under test: every write (`upsert`, `revoke`, `set_attestor`)
//! requires the CURRENT attestor's auth; reads require none. `mock_auths`
//! scopes auth to a specific address per call so the attestor-only invariants
//! are tested for real (not `mock_all_auths`, which would wave everyone
//! through). Expiry is ledger-sequence based, exercised by advancing the
//! test ledger.

extern crate std;

use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    vec, Address, BytesN, Env, IntoVal,
};

use crate::{Contract, ContractClient};

struct Fixture {
    env: Env,
    registry: ContractClient<'static>,
    attestor: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    let attestor = Address::generate(&env);
    let registry_id = env.register(Contract, (attestor.clone(),));
    let registry = ContractClient::new(&env, &registry_id);
    Fixture {
        env,
        registry,
        attestor,
    }
}

fn wasm_hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

/// Invoke `upsert` with auth mocked for `signer` (and only `signer`).
/// Returns whether the call succeeded; error-shape assertions follow the house
/// convention of `is_err()` only (see the policy test suites).
fn upsert_as(
    f: &Fixture,
    signer: &Address,
    contract: &Address,
    hash: &BytesN<32>,
    expires: u32,
) -> bool {
    f.registry
        .mock_auths(&[MockAuth {
            address: signer,
            invoke: &MockAuthInvoke {
                contract: &f.registry.address,
                fn_name: "upsert",
                args: (contract.clone(), hash.clone(), expires).into_val(&f.env),
                sub_invokes: &[],
            },
        }])
        .try_upsert(contract, hash, &expires)
        .is_ok()
}

// ----- Constructor + reads -----

#[test]
fn constructor_sets_attestor_and_unknown_is_unverified() {
    let f = setup();
    assert_eq!(f.registry.attestor(), f.attestor);
    let unknown = Address::generate(&f.env);
    assert!(!f.registry.is_verified(&unknown));
    assert_eq!(f.registry.attestation(&unknown), None);
}

// ----- Upsert -----

#[test]
fn attestor_upsert_marks_verified_and_stores_record() {
    let f = setup();
    let contract = Address::generate(&f.env);
    let hash = wasm_hash(&f.env, 0xAB);
    let now = f.env.ledger().sequence();

    assert!(upsert_as(&f, &f.attestor, &contract, &hash, now + 1000));

    assert!(f.registry.is_verified(&contract));
    let record = f.registry.attestation(&contract).unwrap();
    assert_eq!(record.wasm_hash, hash);
    assert_eq!(record.attested_ledger, now);
    assert_eq!(record.expires_ledger, now + 1000);
}

#[test]
fn non_attestor_cannot_upsert() {
    let f = setup();
    let mallory = Address::generate(&f.env);
    let contract = Address::generate(&f.env);
    let hash = wasm_hash(&f.env, 0x01);
    let expires = f.env.ledger().sequence() + 1000;

    assert!(!upsert_as(&f, &mallory, &contract, &hash, expires));
    assert!(!f.registry.is_verified(&contract));
}

#[test]
fn upsert_refreshes_existing_attestation() {
    let f = setup();
    let contract = Address::generate(&f.env);
    let now = f.env.ledger().sequence();

    assert!(upsert_as(
        &f,
        &f.attestor,
        &contract,
        &wasm_hash(&f.env, 0x01),
        now + 100
    ));
    assert!(upsert_as(
        &f,
        &f.attestor,
        &contract,
        &wasm_hash(&f.env, 0x02),
        now + 5000
    ));

    let record = f.registry.attestation(&contract).unwrap();
    assert_eq!(record.wasm_hash, wasm_hash(&f.env, 0x02));
    assert_eq!(record.expires_ledger, now + 5000);
}

#[test]
fn upsert_rejects_expiry_not_in_future() {
    let f = setup();
    let contract = Address::generate(&f.env);
    let hash = wasm_hash(&f.env, 0x01);
    let now = f.env.ledger().sequence();

    assert!(!upsert_as(&f, &f.attestor, &contract, &hash, now));
    assert!(!f.registry.is_verified(&contract));
}

#[test]
fn upsert_rejects_expiry_beyond_max_lifetime() {
    let f = setup();
    let contract = Address::generate(&f.env);
    let hash = wasm_hash(&f.env, 0x01);
    let now = f.env.ledger().sequence();
    let too_far = now + (60 * 60 * 24 * 365 / 5) + 2;

    assert!(!upsert_as(&f, &f.attestor, &contract, &hash, too_far));
    assert!(!f.registry.is_verified(&contract));
}

// ----- Expiry decay (the fail-closed backstop) -----

#[test]
fn attestation_decays_to_unverified_at_expiry_without_revoke() {
    let f = setup();
    let contract = Address::generate(&f.env);
    let now = f.env.ledger().sequence();
    let expires = now + 100;

    assert!(upsert_as(
        &f,
        &f.attestor,
        &contract,
        &wasm_hash(&f.env, 0x01),
        expires
    ));
    assert!(f.registry.is_verified(&contract));

    // One ledger before expiry: still verified.
    f.env.ledger().with_mut(|l| l.sequence_number = expires - 1);
    assert!(f.registry.is_verified(&contract));

    // At expiry: strictly not verified (record still readable for forensics).
    f.env.ledger().with_mut(|l| l.sequence_number = expires);
    assert!(!f.registry.is_verified(&contract));
    assert!(f.registry.attestation(&contract).is_some());
}

// ----- Revoke -----

#[test]
fn revoke_kills_attestation_immediately_and_is_idempotent() {
    let f = setup();
    let contract = Address::generate(&f.env);
    let now = f.env.ledger().sequence();

    assert!(upsert_as(
        &f,
        &f.attestor,
        &contract,
        &wasm_hash(&f.env, 0x01),
        now + 1000
    ));
    assert!(f.registry.is_verified(&contract));

    f.env.mock_all_auths();
    f.registry.revoke(&contract);
    assert!(!f.registry.is_verified(&contract));
    assert_eq!(f.registry.attestation(&contract), None);

    // Idempotent: revoking again is a no-op, not an error.
    f.registry.revoke(&contract);
    assert!(!f.registry.is_verified(&contract));
}

#[test]
fn non_attestor_cannot_revoke() {
    let f = setup();
    let mallory = Address::generate(&f.env);
    let contract = Address::generate(&f.env);
    let now = f.env.ledger().sequence();

    assert!(upsert_as(
        &f,
        &f.attestor,
        &contract,
        &wasm_hash(&f.env, 0x01),
        now + 1000
    ));

    let result = f
        .registry
        .mock_auths(&[MockAuth {
            address: &mallory,
            invoke: &MockAuthInvoke {
                contract: &f.registry.address,
                fn_name: "revoke",
                args: (contract.clone(),).into_val(&f.env),
                sub_invokes: &[],
            },
        }])
        .try_revoke(&contract);

    assert!(result.is_err());
    assert!(f.registry.is_verified(&contract));
}

#[test]
fn reattestation_after_revoke_works() {
    let f = setup();
    let contract = Address::generate(&f.env);
    let now = f.env.ledger().sequence();

    assert!(upsert_as(
        &f,
        &f.attestor,
        &contract,
        &wasm_hash(&f.env, 0x01),
        now + 1000
    ));
    f.env.mock_all_auths();
    f.registry.revoke(&contract);
    assert!(!f.registry.is_verified(&contract));

    assert!(upsert_as(
        &f,
        &f.attestor,
        &contract,
        &wasm_hash(&f.env, 0x02),
        now + 2000
    ));
    assert!(f.registry.is_verified(&contract));
}

// ----- Attestor rotation -----

#[test]
fn rotation_hands_off_write_authority() {
    let f = setup();
    let new_attestor = Address::generate(&f.env);
    let contract = Address::generate(&f.env);
    let hash = wasm_hash(&f.env, 0x01);
    let expires = f.env.ledger().sequence() + 1000;

    // Current attestor rotates.
    f.registry
        .mock_auths(&[MockAuth {
            address: &f.attestor,
            invoke: &MockAuthInvoke {
                contract: &f.registry.address,
                fn_name: "set_attestor",
                args: (new_attestor.clone(),).into_val(&f.env),
                sub_invokes: &[],
            },
        }])
        .set_attestor(&new_attestor);
    assert_eq!(f.registry.attestor(), new_attestor);

    // Old attestor can no longer write; new one can.
    assert!(!upsert_as(&f, &f.attestor, &contract, &hash, expires));
    assert!(upsert_as(&f, &new_attestor, &contract, &hash, expires));
    assert!(f.registry.is_verified(&contract));
}

#[test]
fn non_attestor_cannot_rotate() {
    let f = setup();
    let mallory = Address::generate(&f.env);

    let result = f
        .registry
        .mock_auths(&[MockAuth {
            address: &mallory,
            invoke: &MockAuthInvoke {
                contract: &f.registry.address,
                fn_name: "set_attestor",
                args: (mallory.clone(),).into_val(&f.env),
                sub_invokes: &[],
            },
        }])
        .try_set_attestor(&mallory);

    assert!(result.is_err());
    assert_eq!(f.registry.attestor(), f.attestor);
}

// ----- Publisher attribution (trusted-publishers policy mode) -----

fn publisher_id(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

/// Invoke `upsert_with_publisher` with auth mocked for `signer` only.
fn upsert_with_publisher_as(
    f: &Fixture,
    signer: &Address,
    contract: &Address,
    hash: &BytesN<32>,
    publisher: &BytesN<32>,
    expires: u32,
) -> bool {
    f.registry
        .mock_auths(&[MockAuth {
            address: signer,
            invoke: &MockAuthInvoke {
                contract: &f.registry.address,
                fn_name: "upsert_with_publisher",
                args: (contract.clone(), hash.clone(), publisher.clone(), expires).into_val(&f.env),
                sub_invokes: &[],
            },
        }])
        .try_upsert_with_publisher(contract, hash, publisher, &expires)
        .is_ok()
}

#[test]
fn attributed_upsert_stores_publisher_and_is_verified() {
    let f = setup();
    let contract = Address::generate(&f.env);
    let now = f.env.ledger().sequence();
    let publisher = publisher_id(&f.env, 0x42);

    assert!(upsert_with_publisher_as(
        &f,
        &f.attestor,
        &contract,
        &wasm_hash(&f.env, 0x01),
        &publisher,
        now + 1000
    ));
    assert!(f.registry.is_verified(&contract));
    assert_eq!(f.registry.publisher_of(&contract), Some(publisher.clone()));
    assert_eq!(
        f.registry.attestation(&contract).unwrap().publisher,
        Some(publisher)
    );
}

#[test]
fn unattributed_upsert_has_no_publisher() {
    // Legacy `upsert` keeps working; the attestation is verified but never
    // matches a trusted-publisher set.
    let f = setup();
    let contract = Address::generate(&f.env);
    let now = f.env.ledger().sequence();
    assert!(upsert_as(
        &f,
        &f.attestor,
        &contract,
        &wasm_hash(&f.env, 0x01),
        now + 1000
    ));
    assert!(f.registry.is_verified(&contract));
    assert_eq!(f.registry.publisher_of(&contract), None);
}

#[test]
fn non_attestor_cannot_attribute() {
    let f = setup();
    let mallory = Address::generate(&f.env);
    let contract = Address::generate(&f.env);
    let now = f.env.ledger().sequence();
    assert!(!upsert_with_publisher_as(
        &f,
        &mallory,
        &contract,
        &wasm_hash(&f.env, 0x01),
        &publisher_id(&f.env, 0x42),
        now + 1000
    ));
    assert_eq!(f.registry.publisher_of(&contract), None);
}

#[test]
fn publisher_decays_with_the_attestation() {
    // Attribution is only meaningful while the provenance claim is live.
    let f = setup();
    let contract = Address::generate(&f.env);
    let now = f.env.ledger().sequence();
    let expires = now + 100;
    assert!(upsert_with_publisher_as(
        &f,
        &f.attestor,
        &contract,
        &wasm_hash(&f.env, 0x01),
        &publisher_id(&f.env, 0x42),
        expires
    ));
    assert!(f.registry.publisher_of(&contract).is_some());
    f.env.ledger().with_mut(|l| l.sequence_number = expires);
    assert_eq!(f.registry.publisher_of(&contract), None);
}

#[test]
fn revoke_clears_publisher_and_reupsert_without_publisher_drops_attribution() {
    let f = setup();
    let contract = Address::generate(&f.env);
    let now = f.env.ledger().sequence();
    assert!(upsert_with_publisher_as(
        &f,
        &f.attestor,
        &contract,
        &wasm_hash(&f.env, 0x01),
        &publisher_id(&f.env, 0x42),
        now + 1000
    ));
    f.env.mock_all_auths();
    f.registry.revoke(&contract);
    assert_eq!(f.registry.publisher_of(&contract), None);

    // A later unattributed re-attestation must not resurrect the old publisher.
    f.registry
        .upsert(&contract, &wasm_hash(&f.env, 0x02), &(now + 2000));
    assert!(f.registry.is_verified(&contract));
    assert_eq!(f.registry.publisher_of(&contract), None);
}

// ----- Event emission (#592: off-chain indexers discover attestations via
// events rather than polling full contract state) -----

#[test]
fn successful_upsert_emits_attest_event_with_contract_and_wasm_hash() {
    let f = setup();
    let contract = Address::generate(&f.env);
    let hash = wasm_hash(&f.env, 0xAB);
    let now = f.env.ledger().sequence();
    let expires = now + 1000;

    assert!(upsert_as(&f, &f.attestor, &contract, &hash, expires));

    // Exactly one event, carrying the contract id (topic) and the wasm hash
    // (data), as required by the issue's acceptance criteria.
    let events = f.env.events().all();
    assert_eq!(
        events,
        vec![
            &f.env,
            (
                f.registry.address.clone(),
                (symbol_short!("attest"), contract.clone()).into_val(&f.env),
                (hash.clone(), expires).into_val(&f.env),
            ),
        ]
    );
}

#[test]
fn rejected_upsert_emits_no_event() {
    // A write that fails validation (expiry not strictly in the future) must
    // not emit an event: an off-chain indexer should never see a record for an
    // attestation that was never actually written.
    let f = setup();
    let contract = Address::generate(&f.env);
    let hash = wasm_hash(&f.env, 0x01);
    let now = f.env.ledger().sequence();

    assert!(!upsert_as(&f, &f.attestor, &contract, &hash, now));
    assert!(f.env.events().all().events().is_empty());
}

#[test]
fn rejected_upsert_by_non_attestor_emits_no_event() {
    // Failing the auth check (not even reaching validation) must also emit
    // nothing.
    let f = setup();
    let mallory = Address::generate(&f.env);
    let contract = Address::generate(&f.env);
    let hash = wasm_hash(&f.env, 0x01);
    let expires = f.env.ledger().sequence() + 1000;

    assert!(!upsert_as(&f, &mallory, &contract, &hash, expires));
    assert!(f.env.events().all().events().is_empty());
}

#[test]
fn upsert_with_publisher_emits_attest_event_with_contract_and_wasm_hash() {
    // The publisher-attributed write path shares the same event shape as the
    // unattributed one — the event is about "this contract's code was
    // attested", not about attribution.
    let f = setup();
    let contract = Address::generate(&f.env);
    let hash = wasm_hash(&f.env, 0x01);
    let publisher = publisher_id(&f.env, 0x42);
    let now = f.env.ledger().sequence();
    let expires = now + 1000;

    assert!(upsert_with_publisher_as(
        &f,
        &f.attestor,
        &contract,
        &hash,
        &publisher,
        expires
    ));

    let events = f.env.events().all();
    assert_eq!(
        events,
        vec![
            &f.env,
            (
                f.registry.address.clone(),
                (symbol_short!("attest"), contract.clone()).into_val(&f.env),
                (hash.clone(), expires).into_val(&f.env),
            ),
        ]
    );
}

#[test]
fn revoke_emits_revoke_event_only_when_something_was_actually_removed() {
    let f = setup();
    let contract = Address::generate(&f.env);
    let now = f.env.ledger().sequence();

    assert!(upsert_as(
        &f,
        &f.attestor,
        &contract,
        &wasm_hash(&f.env, 0x01),
        now + 1000
    ));

    f.env.mock_all_auths();
    f.registry.revoke(&contract);

    let events = f.env.events().all();
    assert_eq!(
        events,
        vec![
            &f.env,
            (
                f.registry.address.clone(),
                (symbol_short!("revoke"), contract.clone()).into_val(&f.env),
                ().into_val(&f.env),
            ),
        ]
    );
}
