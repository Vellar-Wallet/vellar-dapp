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

// ----- #774: a second `set_attestor` after the one-time migration handoff. -----

#[test]
fn second_set_attestor_by_original_key_is_rejected_after_handoff() {
    let f = setup();
    let new_attestor = Address::generate(&f.env);
    let unintended_target = Address::generate(&f.env);

    // Step 2 of docs/threshold-attestor-migration.md: the original single key
    // hands authority to the threshold attestor contract. This succeeds once.
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

    // The original key tries a SECOND handoff to an unintended address. It has
    // lost all authority, so the reassignment is rejected and the registry's
    // attestor is unchanged. This is the mainnet-incident the issue guards
    // against: a casual second `set_attestor` by the retired key cannot work.
    let result = f
        .registry
        .mock_auths(&[MockAuth {
            address: &f.attestor,
            invoke: &MockAuthInvoke {
                contract: &f.registry.address,
                fn_name: "set_attestor",
                args: (unintended_target.clone(),).into_val(&f.env),
                sub_invokes: &[],
            },
        }])
        .try_set_attestor(&unintended_target);

    assert!(result.is_err());
    assert_eq!(f.registry.attestor(), new_attestor);
}

#[test]
fn reassignment_after_handoff_requires_current_attestor_auth() {
    let f = setup();
    let threshold_attestor = Address::generate(&f.env);
    let replacement = Address::generate(&f.env);

    // First handoff, as above.
    f.registry
        .mock_auths(&[MockAuth {
            address: &f.attestor,
            invoke: &MockAuthInvoke {
                contract: &f.registry.address,
                fn_name: "set_attestor",
                args: (threshold_attestor.clone(),).into_val(&f.env),
                sub_invokes: &[],
            },
        }])
        .set_attestor(&threshold_attestor);

    // Documented re-assignment process: there is no global one-time lock on
    // `set_attestor`. A legitimate future rotation is performed by the CURRENT
    // attestor, which is now the threshold contract and authorises through its
    // own 2-of-3 `__check_auth` (see threshold-attestor/src/test.rs). The old
    // single key is deliberately NOT able to do this.
    f.registry
        .mock_auths(&[MockAuth {
            address: &threshold_attestor,
            invoke: &MockAuthInvoke {
                contract: &f.registry.address,
                fn_name: "set_attestor",
                args: (replacement.clone(),).into_val(&f.env),
                sub_invokes: &[],
            },
        }])
        .set_attestor(&replacement);
    assert_eq!(f.registry.attestor(), replacement);
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

// ----- Never-written vs written-then-revoked (#822) -----
//
// The verification service has to render "never verified" differently from
// "previously verified, now revoked" (the same distinction the extension's
// approval screen draws, #701). What the contract actually offers:
//
// * Storage reads (`attestation`, `is_verified`, `publisher_of`) CANNOT tell
//   the two apart: `revoke` removes the persistent record outright, leaving
//   the same absent/false answers a never-written id gives.
// * The only on-chain signal is the event history: a revoked contract has an
//   earlier `attest` event followed by a `revoke` event, a never-written one
//   has none. These tests pin that contract so a consumer that relies on it
//   (or a future change that adds a tombstone) is a deliberate decision.
// * A merely EXPIRED attestation is different from both: its record is still
//   readable, so `attestation()` returns `Some` while `is_verified` is false.

#[test]
fn never_written_contract_reads_as_absent_and_emits_nothing() {
    let f = setup();
    let never_written = Address::generate(&f.env);

    assert_eq!(f.registry.attestation(&never_written), None);
    assert!(!f.registry.is_verified(&never_written));
    assert_eq!(f.registry.publisher_of(&never_written), None);

    // Reads are free of side effects: no event is produced for an unknown id.
    assert!(f.env.events().all().events().is_empty());
}

#[test]
fn revoked_contract_reads_identically_to_never_written_in_storage() {
    let f = setup();
    let never_written = Address::generate(&f.env);
    let revoked = Address::generate(&f.env);
    let publisher = publisher_id(&f.env, 0x42);
    let now = f.env.ledger().sequence();

    assert!(upsert_with_publisher_as(
        &f,
        &f.attestor,
        &revoked,
        &wasm_hash(&f.env, 0x01),
        &publisher,
        now + 1000
    ));
    assert!(f.registry.is_verified(&revoked));
    assert_eq!(f.registry.publisher_of(&revoked), Some(publisher));

    f.env.mock_all_auths();
    f.registry.revoke(&revoked);

    // After revocation every view matches the never-written contract: the
    // return values alone cannot distinguish the two states.
    assert_eq!(
        f.registry.attestation(&revoked),
        f.registry.attestation(&never_written)
    );
    assert_eq!(f.registry.attestation(&revoked), None);
    assert_eq!(
        f.registry.is_verified(&revoked),
        f.registry.is_verified(&never_written)
    );
    assert!(!f.registry.is_verified(&revoked));
    assert_eq!(
        f.registry.publisher_of(&revoked),
        f.registry.publisher_of(&never_written)
    );
    assert_eq!(f.registry.publisher_of(&revoked), None);
}

#[test]
fn revoked_contract_is_distinguishable_from_never_written_by_its_events() {
    let f = setup();
    let never_written = Address::generate(&f.env);
    let revoked = Address::generate(&f.env);
    let hash = wasm_hash(&f.env, 0xAB);
    let now = f.env.ledger().sequence();
    let expires = now + 1000;

    // Step 1: the attestation write emits `attest` for the revoked contract.
    assert!(upsert_as(&f, &f.attestor, &revoked, &hash, expires));
    assert_eq!(
        f.env.events().all(),
        vec![
            &f.env,
            (
                f.registry.address.clone(),
                (symbol_short!("attest"), revoked.clone()).into_val(&f.env),
                (hash.clone(), expires).into_val(&f.env),
            ),
        ]
    );

    // Step 2: revocation emits `revoke` for it.
    f.env.mock_all_auths();
    f.registry.revoke(&revoked);
    assert_eq!(
        f.env.events().all(),
        vec![
            &f.env,
            (
                f.registry.address.clone(),
                (symbol_short!("revoke"), revoked.clone()).into_val(&f.env),
                ().into_val(&f.env),
            ),
        ]
    );

    // Step 3: the never-written contract has no history at all; reading it
    // produces no event, so an indexer finds nothing for it.
    assert_eq!(f.registry.attestation(&never_written), None);
    assert!(f.env.events().all().events().is_empty());
}

#[test]
fn revoking_a_never_written_contract_is_a_noop_that_still_reads_as_never_written() {
    let f = setup();
    let never_written = Address::generate(&f.env);

    // Idempotent: no error, no record created.
    f.env.mock_all_auths();
    f.registry.revoke(&never_written);

    assert_eq!(f.registry.attestation(&never_written), None);
    assert!(!f.registry.is_verified(&never_written));
    assert_eq!(f.registry.publisher_of(&never_written), None);

    // Current behaviour worth knowing: `revoke` publishes its event even when
    // nothing was removed, so a `revoke` event ALONE does not prove the
    // contract was ever attested. Consumers must look for the earlier `attest`
    // event. If this ever changes (event only on real removal), update here.
    assert_eq!(
        f.env.events().all(),
        vec![
            &f.env,
            (
                f.registry.address.clone(),
                (symbol_short!("revoke"), never_written.clone()).into_val(&f.env),
                ().into_val(&f.env),
            ),
        ]
    );
}

#[test]
fn expired_attestation_is_distinguishable_from_never_written_and_revoked() {
    let f = setup();
    let never_written = Address::generate(&f.env);
    let revoked = Address::generate(&f.env);
    let expired = Address::generate(&f.env);
    let now = f.env.ledger().sequence();
    let expires = now + 100;

    assert!(upsert_as(
        &f,
        &f.attestor,
        &revoked,
        &wasm_hash(&f.env, 0x01),
        now + 1000
    ));
    assert!(upsert_as(
        &f,
        &f.attestor,
        &expired,
        &wasm_hash(&f.env, 0x02),
        expires
    ));

    f.env.mock_all_auths();
    f.registry.revoke(&revoked);
    f.env.ledger().with_mut(|l| l.sequence_number = expires);

    // None of the three is verified...
    assert!(!f.registry.is_verified(&never_written));
    assert!(!f.registry.is_verified(&revoked));
    assert!(!f.registry.is_verified(&expired));

    // ...but only the expired one still has a readable record (for forensics).
    assert_eq!(f.registry.attestation(&never_written), None);
    assert_eq!(f.registry.attestation(&revoked), None);
    let record = f
        .registry
        .attestation(&expired)
        .expect("expired record stays readable");
    assert_eq!(record.wasm_hash, wasm_hash(&f.env, 0x02));
    assert_eq!(record.expires_ledger, expires);
}

#[test]
fn revoked_contract_can_be_reattested_while_never_written_stays_absent() {
    let f = setup();
    let never_written = Address::generate(&f.env);
    let revoked = Address::generate(&f.env);
    let now = f.env.ledger().sequence();

    assert!(upsert_as(
        &f,
        &f.attestor,
        &revoked,
        &wasm_hash(&f.env, 0x01),
        now + 1000
    ));
    f.env.mock_all_auths();
    f.registry.revoke(&revoked);
    assert!(!f.registry.is_verified(&revoked));

    // Re-attestation of the previously revoked id works...
    f.registry
        .upsert(&revoked, &wasm_hash(&f.env, 0x03), &(now + 2000));
    assert!(f.registry.is_verified(&revoked));
    assert_eq!(
        f.registry.attestation(&revoked).map(|a| a.wasm_hash),
        Some(wasm_hash(&f.env, 0x03))
    );

    // ...and nothing about it leaks onto an id that was never written.
    assert!(!f.registry.is_verified(&never_written));
    assert_eq!(f.registry.attestation(&never_written), None);
}
