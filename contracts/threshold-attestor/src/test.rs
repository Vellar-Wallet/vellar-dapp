#![cfg(test)]

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    auth::{ContractContext, CustomAccountInterface},
    symbol_short,
    testutils::Address as _,
    Address, Bytes, BytesN, Env, Vec,
};
use vela_attestation_registry::{
    Contract as AttestationRegistryContract, ContractClient as AttestationRegistryClient,
};

fn generate_key(env: &Env, seed_byte: u8) -> (SigningKey, BytesN<32>) {
    let mut seed = [0u8; 32];
    seed[0] = seed_byte;
    let signing_key = SigningKey::from_bytes(&seed);
    let vk_bytes = signing_key.verifying_key().to_bytes();
    (signing_key, BytesN::from_array(env, &vk_bytes))
}

fn create_payload_and_hash(env: &Env, raw: &[u8; 32]) -> (Hash<32>, [u8; 32]) {
    let bytes = Bytes::from_array(env, raw);
    let hash = env.crypto().sha256(&bytes);
    let arr = hash.to_bytes().to_array();
    (hash, arr)
}

#[test]
#[should_panic]
fn test_constructor_zero_threshold_fails() {
    let env = Env::default();
    let (_, pk1) = generate_key(&env, 1);
    let (_, pk2) = generate_key(&env, 2);
    let signers = Vec::from_array(&env, [pk1, pk2]);
    env.register(Contract, (0u32, signers, None::<u32>));
}

#[test]
#[should_panic]
fn test_constructor_threshold_exceeds_signers_fails() {
    let env = Env::default();
    let (_, pk1) = generate_key(&env, 1);
    let (_, pk2) = generate_key(&env, 2);
    let signers = Vec::from_array(&env, [pk1, pk2]);
    env.register(Contract, (3u32, signers, None::<u32>));
}

#[test]
#[should_panic]
fn test_constructor_duplicate_signers_fails() {
    let env = Env::default();
    let (_, pk1) = generate_key(&env, 1);
    let dup_signers = Vec::from_array(&env, [pk1.clone(), pk1]);
    env.register(Contract, (1u32, dup_signers, None::<u32>));
}

#[test]
fn test_views_and_getters() {
    let env = Env::default();
    let (_, pk1) = generate_key(&env, 1);
    let (_, pk2) = generate_key(&env, 2);
    let (_, pk3) = generate_key(&env, 3);

    let signers = Vec::from_array(&env, [pk1.clone(), pk2.clone(), pk3.clone()]);
    let contract_id = env.register(Contract, (2u32, signers.clone(), Some(1u32)));
    let client = ContractClient::new(&env, &contract_id);

    assert_eq!(client.threshold(), 2);
    assert_eq!(client.revoke_threshold(), 1);
    assert_eq!(client.signer_count(), 3);
    assert_eq!(client.signers().len(), 3);
}

#[test]
fn test_check_auth_threshold_success() {
    let env = Env::default();
    let (sk1, pk1) = generate_key(&env, 1);
    let (sk2, pk2) = generate_key(&env, 2);
    let (_sk3, pk3) = generate_key(&env, 3);

    let signers = Vec::from_array(&env, [pk1, pk2, pk3]);
    let contract_id = env.register(Contract, (2u32, signers, None::<u32>));

    let (hash_payload, payload_bytes) = create_payload_and_hash(&env, &[42u8; 32]);
    let sig1_bytes = sk1.sign(&payload_bytes).to_bytes();
    let sig2_bytes = sk2.sign(&payload_bytes).to_bytes();

    let sigs = ThresholdSignatures {
        signatures: Vec::from_array(
            &env,
            [
                SignerSignature {
                    signer_index: 0,
                    signature: BytesN::from_array(&env, &sig1_bytes),
                },
                SignerSignature {
                    signer_index: 1,
                    signature: BytesN::from_array(&env, &sig2_bytes),
                },
            ],
        ),
    };

    let target_contract = Address::generate(&env);
    let auth_contexts = Vec::from_array(
        &env,
        [Context::Contract(ContractContext {
            contract: target_contract,
            fn_name: symbol_short!("upsert"),
            args: Vec::new(&env),
        })],
    );

    let res = env.as_contract(&contract_id, || {
        Contract::__check_auth(env.clone(), hash_payload, sigs, auth_contexts)
    });

    assert_eq!(res, Ok(()));
}

#[test]
fn test_check_auth_insufficient_signatures() {
    let env = Env::default();
    let (sk1, pk1) = generate_key(&env, 1);
    let (_sk2, pk2) = generate_key(&env, 2);

    let signers = Vec::from_array(&env, [pk1, pk2]);
    let contract_id = env.register(Contract, (2u32, signers, None::<u32>));

    let (hash_payload, payload_bytes) = create_payload_and_hash(&env, &[77u8; 32]);
    let sig1_bytes = sk1.sign(&payload_bytes).to_bytes();

    // Provide only 1 signature when threshold is 2
    let sigs = ThresholdSignatures {
        signatures: Vec::from_array(
            &env,
            [SignerSignature {
                signer_index: 0,
                signature: BytesN::from_array(&env, &sig1_bytes),
            }],
        ),
    };

    let target_contract = Address::generate(&env);
    let auth_contexts = Vec::from_array(
        &env,
        [Context::Contract(ContractContext {
            contract: target_contract,
            fn_name: symbol_short!("upsert"),
            args: Vec::new(&env),
        })],
    );

    let res = env.as_contract(&contract_id, || {
        Contract::__check_auth(env.clone(), hash_payload, sigs, auth_contexts)
    });

    assert_eq!(res, Err(ThresholdError::InsufficientSignatures));
}

#[test]
fn test_check_auth_rejects_duplicate_or_unsorted_signers() {
    let env = Env::default();
    let (sk1, pk1) = generate_key(&env, 1);
    let (_sk2, pk2) = generate_key(&env, 2);

    let signers = Vec::from_array(&env, [pk1, pk2]);
    let contract_id = env.register(Contract, (2u32, signers, None::<u32>));

    let (hash_payload, payload_bytes) = create_payload_and_hash(&env, &[99u8; 32]);
    let sig1_bytes = sk1.sign(&payload_bytes).to_bytes();

    // Duplicate signer_index 0
    let dup_sigs = ThresholdSignatures {
        signatures: Vec::from_array(
            &env,
            [
                SignerSignature {
                    signer_index: 0,
                    signature: BytesN::from_array(&env, &sig1_bytes),
                },
                SignerSignature {
                    signer_index: 0,
                    signature: BytesN::from_array(&env, &sig1_bytes),
                },
            ],
        ),
    };

    let target = Address::generate(&env);
    let auth_contexts = Vec::from_array(
        &env,
        [Context::Contract(ContractContext {
            contract: target,
            fn_name: symbol_short!("upsert"),
            args: Vec::new(&env),
        })],
    );

    let res = env.as_contract(&contract_id, || {
        Contract::__check_auth(env.clone(), hash_payload, dup_sigs, auth_contexts)
    });

    assert_eq!(res, Err(ThresholdError::InvalidSignerIndex));
}

#[test]
fn test_fast_path_revocation_threshold() {
    let env = Env::default();
    let (sk1, pk1) = generate_key(&env, 1);
    let (_sk2, pk2) = generate_key(&env, 2);
    let (_sk3, pk3) = generate_key(&env, 3);

    let signers = Vec::from_array(&env, [pk1, pk2, pk3]);
    // 2-of-3 for normal ops, but 1-of-3 for fast-path revoke
    let contract_id = env.register(Contract, (2u32, signers, Some(1u32)));

    let (hash_payload, payload_bytes) = create_payload_and_hash(&env, &[123u8; 32]);
    let sig1_bytes = sk1.sign(&payload_bytes).to_bytes();

    let single_sig = ThresholdSignatures {
        signatures: Vec::from_array(
            &env,
            [SignerSignature {
                signer_index: 0,
                signature: BytesN::from_array(&env, &sig1_bytes),
            }],
        ),
    };

    let target = Address::generate(&env);

    // Revoke context: single signature is enough because revoke_threshold == 1
    let revoke_contexts = Vec::from_array(
        &env,
        [Context::Contract(ContractContext {
            contract: target.clone(),
            fn_name: symbol_short!("revoke"),
            args: Vec::new(&env),
        })],
    );

    let revoke_res = env.as_contract(&contract_id, || {
        Contract::__check_auth(
            env.clone(),
            hash_payload.clone(),
            single_sig.clone(),
            revoke_contexts,
        )
    });
    assert_eq!(revoke_res, Ok(()));

    // Upsert context: single signature fails because threshold == 2
    let upsert_contexts = Vec::from_array(
        &env,
        [Context::Contract(ContractContext {
            contract: target,
            fn_name: symbol_short!("upsert"),
            args: Vec::new(&env),
        })],
    );

    let upsert_res = env.as_contract(&contract_id, || {
        Contract::__check_auth(env.clone(), hash_payload, single_sig, upsert_contexts)
    });
    assert_eq!(upsert_res, Err(ThresholdError::InsufficientSignatures));
}

#[test]
fn test_integration_with_attestation_registry() {
    let env = Env::default();
    let (_, pk1) = generate_key(&env, 1);
    let (_, pk2) = generate_key(&env, 2);
    let (_, pk3) = generate_key(&env, 3);

    let signers = Vec::from_array(&env, [pk1, pk2, pk3]);
    let threshold_attestor_id = env.register(Contract, (2u32, signers, Some(1u32)));

    // Deploy attestation registry pointing to the threshold attestor contract!
    let registry_id = env.register(
        AttestationRegistryContract,
        (threshold_attestor_id.clone(),),
    );
    let registry = AttestationRegistryClient::new(&env, &registry_id);

    assert_eq!(registry.attestor(), threshold_attestor_id);

    // Mock contract to attest
    let target = Address::generate(&env);
    let wasm_hash = BytesN::from_array(&env, &[9u8; 32]);
    let expires_ledger = env.ledger().sequence() + 1000;

    // Direct registry call requires auth of threshold_attestor_id
    env.mock_all_auths();
    registry.upsert(&target, &wasm_hash, &expires_ledger);

    assert!(registry.is_verified(&target));
    assert_eq!(registry.attestation(&target).unwrap().wasm_hash, wasm_hash);

    // Revoke
    registry.revoke(&target);
    assert!(!registry.is_verified(&target));
}

// ----- #593: threshold exactly equal to signer count (unanimous), and the
// threshold == 1 boundary (any single signer suffices), as distinct
// configurations from "threshold strictly below signer count". -----

#[test]
fn test_unanimous_threshold_succeeds_only_when_every_signer_has_signed() {
    // threshold == signer_count: ALL THREE signers must sign; this is a
    // distinct boundary from the general "2 of 3" case already covered by
    // `test_check_auth_threshold_success` above.
    let env = Env::default();
    let (sk1, pk1) = generate_key(&env, 1);
    let (sk2, pk2) = generate_key(&env, 2);
    let (sk3, pk3) = generate_key(&env, 3);

    let signers = Vec::from_array(&env, [pk1, pk2, pk3]);
    let contract_id = env.register(Contract, (3u32, signers, None::<u32>));

    let (hash_payload, payload_bytes) = create_payload_and_hash(&env, &[7u8; 32]);
    let target_contract = Address::generate(&env);
    let auth_contexts = Vec::from_array(
        &env,
        [Context::Contract(ContractContext {
            contract: target_contract,
            fn_name: symbol_short!("upsert"),
            args: Vec::new(&env),
        })],
    );

    // All three sign: unanimous agreement reached, must succeed.
    let sig1_bytes = sk1.sign(&payload_bytes).to_bytes();
    let sig2_bytes = sk2.sign(&payload_bytes).to_bytes();
    let sig3_bytes = sk3.sign(&payload_bytes).to_bytes();
    let all_sigs = ThresholdSignatures {
        signatures: Vec::from_array(
            &env,
            [
                SignerSignature {
                    signer_index: 0,
                    signature: BytesN::from_array(&env, &sig1_bytes),
                },
                SignerSignature {
                    signer_index: 1,
                    signature: BytesN::from_array(&env, &sig2_bytes),
                },
                SignerSignature {
                    signer_index: 2,
                    signature: BytesN::from_array(&env, &sig3_bytes),
                },
            ],
        ),
    };
    let res = env.as_contract(&contract_id, || {
        Contract::__check_auth(
            env.clone(),
            hash_payload.clone(),
            all_sigs,
            auth_contexts.clone(),
        )
    });
    assert_eq!(res, Ok(()));

    // Missing even one signer (2 of 3, under a unanimous threshold) fails —
    // the distinguishing property of this boundary vs. a strictly-lower
    // threshold, where 2 of 3 would have been enough.
    let two_sigs = ThresholdSignatures {
        signatures: Vec::from_array(
            &env,
            [
                SignerSignature {
                    signer_index: 0,
                    signature: BytesN::from_array(&env, &sig1_bytes),
                },
                SignerSignature {
                    signer_index: 1,
                    signature: BytesN::from_array(&env, &sig2_bytes),
                },
            ],
        ),
    };
    let res = env.as_contract(&contract_id, || {
        Contract::__check_auth(env.clone(), hash_payload, two_sigs, auth_contexts)
    });
    assert_eq!(res, Err(ThresholdError::InsufficientSignatures));
}

#[test]
fn test_threshold_of_one_any_single_signer_suffices() {
    // threshold == 1: the OTHER boundary — any one of the configured signers
    // alone is enough, in contrast to the unanimous (threshold == signer
    // count) case above. Exercised with each of the three signers in turn to
    // show it is genuinely "any one", not "only signer 0".
    let env = Env::default();
    let (sk1, pk1) = generate_key(&env, 1);
    let (sk2, pk2) = generate_key(&env, 2);
    let (sk3, pk3) = generate_key(&env, 3);

    let signers = Vec::from_array(&env, [pk1, pk2, pk3]);
    let contract_id = env.register(Contract, (1u32, signers, None::<u32>));

    let (hash_payload, payload_bytes) = create_payload_and_hash(&env, &[11u8; 32]);
    let target_contract = Address::generate(&env);
    let auth_contexts = Vec::from_array(
        &env,
        [Context::Contract(ContractContext {
            contract: target_contract,
            fn_name: symbol_short!("upsert"),
            args: Vec::new(&env),
        })],
    );

    for (index, sk) in [(0u32, &sk1), (1u32, &sk2), (2u32, &sk3)] {
        let sig_bytes = sk.sign(&payload_bytes).to_bytes();
        let sigs = ThresholdSignatures {
            signatures: Vec::from_array(
                &env,
                [SignerSignature {
                    signer_index: index,
                    signature: BytesN::from_array(&env, &sig_bytes),
                }],
            ),
        };
        let res = env.as_contract(&contract_id, || {
            Contract::__check_auth(
                env.clone(),
                hash_payload.clone(),
                sigs,
                auth_contexts.clone(),
            )
        });
        assert_eq!(res, Ok(()));
    }

    // Zero signatures still fails — threshold 1 is not threshold 0.
    let no_sigs = ThresholdSignatures {
        signatures: Vec::new(&env),
    };
    let res = env.as_contract(&contract_id, || {
        Contract::__check_auth(env.clone(), hash_payload, no_sigs, auth_contexts)
    });
    assert_eq!(res, Err(ThresholdError::InsufficientSignatures));
}
