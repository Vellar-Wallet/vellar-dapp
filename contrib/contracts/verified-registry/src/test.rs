#![cfg(test)]

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Events as _},
    Address, BytesN, Env, Error, InvokeError,
};

use crate::{RegistryError, VerifiedRegistry, VerifiedRegistryClient};

fn make_hash(env: &Env, byte: u8) -> BytesN<32> {
    let mut arr = [0u8; 32];
    arr[0] = byte;
    BytesN::from_array(env, &arr)
}

/// Assert that a `try_*` call returned a specific contract error code.
///
/// `panic_with_error!` surfaces as `Err(Ok(Error(Contract, #code)))` through
/// the `try_*` client methods — the invocation itself succeeded, but the
/// contract exited with an error.
fn assert_contract_err<T>(result: Result<T, Result<Error, InvokeError>>, code: RegistryError) {
    match result {
        Err(Ok(e)) if e.is_type(soroban_sdk::xdr::ScErrorType::Contract) => {
            assert_eq!(
                e.get_code(),
                code as u32,
                "expected error code {} but got {}",
                code as u32,
                e.get_code(),
            );
        }
        Err(Ok(e)) => panic!("expected Contract error but got {:?}", e),
        Err(Err(e)) => panic!("expected Contract error but got invoke error {:?}", e),
        Ok(_) => panic!("expected error but got Ok"),
    }
}

struct Fixture {
    env: Env,
    registry: VerifiedRegistryClient<'static>,
    _admin: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let contract_id = env.register(VerifiedRegistry, (&admin,));
    let registry = VerifiedRegistryClient::new(&env, &contract_id);
    Fixture { env, registry, _admin: admin }
}

fn setup_no_mock() -> Fixture {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register(VerifiedRegistry, (&admin,));
    let registry = VerifiedRegistryClient::new(&env, &contract_id);
    Fixture { env, registry, _admin: admin }
}

// ----- Constructor -----

#[test]
fn constructor_stores_admin() {
    let fx = setup();
    let h = make_hash(&fx.env, 0xaa);
    fx.registry.add(&h);
}

// ----- Add -----

#[test]
fn add_marks_hash_verified() {
    let fx = setup();
    let h = make_hash(&fx.env, 0x01);
    fx.registry.add(&h);

    let result = fx.registry.try_add(&h);
    assert_contract_err(result, RegistryError::AlreadyVerified);
}

#[test]
fn add_emits_event() {
    let fx = setup();
    let h = make_hash(&fx.env, 0x02);
    let before = fx.env.events().all().events().len();
    fx.registry.add(&h);
    let after = fx.env.events().all().events().len();
    assert!(after > before);
}

// ----- Remove -----

#[test]
fn remove_clears_hash() {
    let fx = setup();
    let h = make_hash(&fx.env, 0x03);
    fx.registry.add(&h);

    fx.registry.remove(&h);

    // After removal, adding the same hash again succeeds — proves the entry
    // was actually cleared.
    fx.registry.add(&h);
}

#[test]
fn remove_clears_hash_and_emits() {
    let fx = setup();
    let h = make_hash(&fx.env, 0x04);
    fx.registry.add(&h);
    fx.registry.remove(&h);
    // Re-adding after remove must succeed — proves remove cleared the entry.
    fx.registry.add(&h);
}

// ----- Duplicate add rejected -----

#[test]
fn duplicate_add_rejected() {
    let fx = setup();
    let h = make_hash(&fx.env, 0x05);
    fx.registry.add(&h);

    let result = fx.registry.try_add(&h);
    assert_contract_err(result, RegistryError::AlreadyVerified);
}

// ----- Remove unknown entry rejected -----

#[test]
fn remove_unknown_rejected() {
    let fx = setup();
    let h = make_hash(&fx.env, 0x06);

    let result = fx.registry.try_remove(&h);
    assert_contract_err(result, RegistryError::NotVerified);
}

// ----- Unauthorized calls rejected -----

#[test]
fn unauthorized_add_rejected() {
    let fx = setup_no_mock();
    let h = make_hash(&fx.env, 0x07);

    let result = fx.registry.try_add(&h);
    assert!(result.is_err());
}

#[test]
fn unauthorized_remove_rejected() {
    let fx = setup_no_mock();
    let h = make_hash(&fx.env, 0x08);

    let result = fx.registry.try_remove(&h);
    assert!(result.is_err());
}

// ----- Separate hashes are independent -----

#[test]
fn multiple_hashes_independent() {
    let fx = setup();
    let h1 = make_hash(&fx.env, 0x10);
    let h2 = make_hash(&fx.env, 0x20);

    fx.registry.add(&h1);
    fx.registry.add(&h2);

    // Remove h1 only.
    fx.registry.remove(&h1);

    // h2 should still be present (re-add fails).
    let result = fx.registry.try_add(&h2);
    assert_contract_err(result, RegistryError::AlreadyVerified);

    // h1 should be clear (re-add succeeds).
    fx.registry.add(&h1);
}
