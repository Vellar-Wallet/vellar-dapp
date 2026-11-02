//! Unit tests for the single-signer revoke cap (docs/design-m5-threshold-attestor.md).
//! They call `__check_auth` directly with hand-built contexts; the on-chain runner
//! (`run-probe.mjs`) repeats the context rules against the real host.
#![cfg(test)]

use soroban_sdk::{
    auth::{
        Context, ContractContext, ContractExecutable, CreateContractHostFnContext,
        CustomAccountInterface,
    },
    crypto::Hash,
    testutils::{Address as _, Ledger},
    Address, Bytes, BytesN, Env, IntoVal, Symbol, Val, Vec,
};

use crate::{Probe, ProbeError, Sig, CAP, WINDOW_LEDGERS};

struct Fixture {
    env: Env,
    attestor: Address,
    registry: Address,
    record: Address,
}

fn fixture() -> Fixture {
    let env = Env::default();
    env.ledger().set_sequence_number(1_000);
    let registry = Address::generate(&env);
    let record = Address::generate(&env);
    let attestor = env.register(Probe, (Some(registry.clone()), false, None::<Address>));
    Fixture {
        env,
        attestor,
        registry,
        record,
    }
}

fn payload(env: &Env) -> Hash<32> {
    env.crypto().sha256(&Bytes::from_array(env, &[7u8; 32]))
}

fn call(env: &Env, contract: &Address, function: &str, args: &[&Address]) -> Context {
    let mut values: Vec<Val> = Vec::new(env);
    for a in args {
        values.push_back((*a).into_val(env));
    }
    Context::Contract(ContractContext {
        contract: contract.clone(),
        fn_name: Symbol::new(env, function),
        args: values,
    })
}

/// The one context the cap accepts: revoke(this account, record) on the bound registry.
fn good(f: &Fixture) -> Vec<Context> {
    Vec::from_array(
        &f.env,
        [call(
            &f.env,
            &f.registry,
            "revoke",
            &[&f.attestor, &f.record],
        )],
    )
}

fn check(f: &Fixture, sig: Sig, contexts: Vec<Context>) -> Result<(), ProbeError> {
    f.env.as_contract(&f.attestor, || {
        <Probe as CustomAccountInterface>::__check_auth(
            f.env.clone(),
            payload(&f.env),
            sig,
            contexts,
        )
    })
}

fn ring(f: &Fixture, signer: u32) -> Vec<u32> {
    f.env
        .as_contract(&f.attestor, || Probe::ring(f.env.clone(), signer))
}

fn at(f: &Fixture, ledger: u32) {
    f.env.ledger().set_sequence_number(ledger);
}

/// A refusal must return the error AND leave every signer's ring exactly as it was.
fn assert_refused_untouched(f: &Fixture, sig: Sig, contexts: Vec<Context>, expected: ProbeError) {
    let before: [Vec<u32>; 3] = [ring(f, 0), ring(f, 1), ring(f, 2)];
    assert_eq!(check(f, sig, contexts), Err(expected));
    assert_eq!(ring(f, 0), before[0]);
    assert_eq!(ring(f, 1), before[1]);
    assert_eq!(ring(f, 2), before[2]);
}

#[test]
fn constants_match_the_design() {
    assert_eq!(CAP, 3);
    assert_eq!(WINDOW_LEDGERS, 17_280); // about 24 hours
}

#[test]
fn accepts_exactly_one_revoke_on_the_bound_registry_and_records_the_ledger() {
    let f = fixture();
    assert_eq!(check(&f, Sig::Single(0), good(&f)), Ok(()));
    assert_eq!(ring(&f, 0), Vec::from_array(&f.env, [1_000u32]));
}

mod context_rules {
    use super::*;

    #[test]
    fn refuses_a_different_function_on_the_bound_registry() {
        let f = fixture();
        let ctx = Vec::from_array(
            &f.env,
            [call(
                &f.env,
                &f.registry,
                "upsert",
                &[&f.attestor, &f.record],
            )],
        );
        assert_refused_untouched(&f, Sig::Single(0), ctx, ProbeError::WrongContext);
    }

    #[test]
    fn refuses_revoke_on_a_different_registry_address() {
        let f = fixture();
        let other = Address::generate(&f.env);
        let ctx = Vec::from_array(
            &f.env,
            [call(&f.env, &other, "revoke", &[&f.attestor, &f.record])],
        );
        assert_refused_untouched(&f, Sig::Single(0), ctx, ProbeError::WrongContext);
    }

    #[test]
    fn refuses_the_attestor_itself_as_the_target() {
        // A call on the attestor, not the registry: still the wrong contract.
        let f = fixture();
        let ctx = Vec::from_array(
            &f.env,
            [call(
                &f.env,
                &f.attestor,
                "revoke",
                &[&f.attestor, &f.record],
            )],
        );
        assert_refused_untouched(&f, Sig::Single(0), ctx, ProbeError::WrongContext);
    }

    #[test]
    fn refuses_an_extra_context_alongside_a_good_revoke() {
        let f = fixture();
        let extra = call(&f.env, &f.registry, "upsert", &[&f.attestor, &f.record]);
        let ctx = Vec::from_array(&f.env, [good(&f).get(0).unwrap(), extra]);
        assert_refused_untouched(&f, Sig::Single(0), ctx, ProbeError::WrongContext);
    }

    #[test]
    fn refuses_two_revokes_in_one_authorisation() {
        let f = fixture();
        let one = good(&f).get(0).unwrap();
        let ctx = Vec::from_array(&f.env, [one.clone(), one]);
        assert_refused_untouched(&f, Sig::Single(0), ctx, ProbeError::WrongContext);
    }

    #[test]
    fn refuses_a_good_revoke_that_is_not_the_first_context() {
        let f = fixture();
        let other = call(&f.env, &f.registry, "upsert", &[&f.attestor, &f.record]);
        let ctx = Vec::from_array(&f.env, [other, good(&f).get(0).unwrap()]);
        assert_refused_untouched(&f, Sig::Single(0), ctx, ProbeError::WrongContext);
    }

    #[test]
    fn refuses_no_context_at_all() {
        let f = fixture();
        assert_refused_untouched(
            &f,
            Sig::Single(0),
            Vec::new(&f.env),
            ProbeError::WrongContext,
        );
    }

    #[test]
    fn refuses_a_wrong_argument_count() {
        let f = fixture();
        let one = Vec::from_array(
            &f.env,
            [call(&f.env, &f.registry, "revoke", &[&f.attestor])],
        );
        let three = Vec::from_array(
            &f.env,
            [call(
                &f.env,
                &f.registry,
                "revoke",
                &[&f.attestor, &f.record, &f.record],
            )],
        );
        assert_refused_untouched(&f, Sig::Single(0), one, ProbeError::WrongContext);
        assert_refused_untouched(&f, Sig::Single(0), three, ProbeError::WrongContext);
    }

    #[test]
    fn refuses_a_revoke_authorising_a_different_account() {
        // First argument is not this attestor.
        let f = fixture();
        let stranger = Address::generate(&f.env);
        let ctx = Vec::from_array(
            &f.env,
            [call(&f.env, &f.registry, "revoke", &[&stranger, &f.record])],
        );
        assert_refused_untouched(&f, Sig::Single(0), ctx, ProbeError::WrongContext);
    }

    #[test]
    fn refuses_a_contract_creation_context() {
        let f = fixture();
        let create = Context::CreateContractHostFn(CreateContractHostFnContext {
            executable: ContractExecutable::Wasm(BytesN::from_array(&f.env, &[0u8; 32])),
            salt: BytesN::from_array(&f.env, &[1u8; 32]),
        });
        let ctx = Vec::from_array(&f.env, [create]);
        assert_refused_untouched(&f, Sig::Single(0), ctx, ProbeError::WrongContext);
    }

    #[test]
    fn refuses_when_no_registry_is_bound() {
        let env = Env::default();
        let attestor = env.register(Probe, (None::<Address>, false, None::<Address>));
        let record = Address::generate(&env);
        let registry = Address::generate(&env);
        let f = Fixture {
            env,
            attestor,
            registry,
            record,
        };
        assert_refused_untouched(&f, Sig::Single(0), good(&f), ProbeError::NotBound);
    }

    #[test]
    fn a_refusal_in_the_middle_of_valid_use_does_not_cost_an_allowance() {
        let f = fixture();
        let bad = Vec::from_array(
            &f.env,
            [call(
                &f.env,
                &f.registry,
                "upsert",
                &[&f.attestor, &f.record],
            )],
        );
        for _ in 0..10 {
            assert_eq!(
                check(&f, Sig::Single(0), bad.clone()),
                Err(ProbeError::WrongContext)
            );
        }
        // All three allowances are still available.
        for _ in 0..CAP {
            assert_eq!(check(&f, Sig::Single(0), good(&f)), Ok(()));
        }
    }
}

mod cap {
    use super::*;

    #[test]
    fn the_fourth_single_signer_revoke_in_the_window_is_refused() {
        let f = fixture();
        for _ in 0..CAP {
            assert_eq!(check(&f, Sig::Single(0), good(&f)), Ok(()));
        }
        assert_refused_untouched(&f, Sig::Single(0), good(&f), ProbeError::CapReached);
        assert_eq!(ring(&f, 0).len(), CAP);
    }

    #[test]
    fn the_window_boundary_is_17_279_refused_and_17_280_allowed() {
        let f = fixture();
        at(&f, 1_000);
        assert_eq!(check(&f, Sig::Single(0), good(&f)), Ok(()));
        at(&f, 1_010);
        assert_eq!(check(&f, Sig::Single(0), good(&f)), Ok(()));
        at(&f, 1_020);
        assert_eq!(check(&f, Sig::Single(0), good(&f)), Ok(()));

        // The oldest is from ledger 1,000. One ledger short of a full window: still refused.
        at(&f, 1_000 + WINDOW_LEDGERS - 1);
        assert_refused_untouched(&f, Sig::Single(0), good(&f), ProbeError::CapReached);

        // A full window later the oldest has aged out and one slot is free again.
        at(&f, 1_000 + WINDOW_LEDGERS);
        assert_eq!(check(&f, Sig::Single(0), good(&f)), Ok(()));
        assert_eq!(
            ring(&f, 0),
            Vec::from_array(&f.env, [1_010u32, 1_020, 1_000 + WINDOW_LEDGERS])
        );

        // That is a full allowance again, so an immediate further attempt is refused.
        assert_refused_untouched(&f, Sig::Single(0), good(&f), ProbeError::CapReached);
    }

    #[test]
    fn aged_out_entries_are_pruned_so_the_ring_never_grows() {
        let f = fixture();
        for round in 0..5u32 {
            at(&f, 1_000 + round * WINDOW_LEDGERS);
            for _ in 0..CAP {
                assert_eq!(check(&f, Sig::Single(0), good(&f)), Ok(()));
            }
            assert_eq!(ring(&f, 0).len(), CAP);
        }
    }

    #[test]
    fn signers_have_independent_allowances() {
        let f = fixture();
        for _ in 0..CAP {
            assert_eq!(check(&f, Sig::Single(0), good(&f)), Ok(()));
        }
        assert_refused_untouched(&f, Sig::Single(0), good(&f), ProbeError::CapReached);
        // Signer 1 and signer 2 are unaffected.
        assert_eq!(check(&f, Sig::Single(1), good(&f)), Ok(()));
        assert_eq!(check(&f, Sig::Single(2), good(&f)), Ok(()));
        assert_eq!(ring(&f, 1).len(), 1);
        assert_eq!(ring(&f, 2).len(), 1);
    }

    #[test]
    fn a_two_signature_revoke_never_consumes_an_allowance() {
        let f = fixture();
        for _ in 0..10 {
            assert_eq!(check(&f, Sig::Pair, good(&f)), Ok(()));
        }
        assert_eq!(ring(&f, 0).len(), 0);
        assert_eq!(ring(&f, 1).len(), 0);
        assert_eq!(ring(&f, 2).len(), 0);
    }

    #[test]
    fn a_two_signature_revoke_still_works_after_a_signer_is_exhausted() {
        let f = fixture();
        for _ in 0..CAP {
            assert_eq!(check(&f, Sig::Single(0), good(&f)), Ok(()));
        }
        assert_eq!(
            check(&f, Sig::Single(0), good(&f)),
            Err(ProbeError::CapReached)
        );
        assert_eq!(check(&f, Sig::Pair, good(&f)), Ok(()));
        assert_eq!(ring(&f, 0).len(), CAP); // untouched by the pair
    }

    #[test]
    fn two_signatures_are_not_limited_to_the_single_signer_context_rules() {
        // The threshold path authorises other calls (attest, rotate); the context rule
        // is only a limit on what ONE signature may do.
        let f = fixture();
        let upsert = Vec::from_array(
            &f.env,
            [call(
                &f.env,
                &f.registry,
                "upsert",
                &[&f.attestor, &f.record],
            )],
        );
        assert_eq!(check(&f, Sig::Pair, upsert), Ok(()));
    }
}
