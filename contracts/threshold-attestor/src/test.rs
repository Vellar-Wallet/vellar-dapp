#![cfg(test)]

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    auth::{ContractContext, CustomAccountInterface},
    symbol_short, testutils::Address as _,
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
    let registry_id =
        env.register(AttestationRegistryContract, (threshold_attestor_id.clone(),));
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
    assert_eq!(
        registry.attestation(&target).unwrap().wasm_hash,
        wasm_hash
    );

    // Revoke
    registry.revoke(&target);
    assert!(!registry.is_verified(&target));
}

#[test]
fn test_check_auth_unanimous_threshold_equals_signer_count() {
    let env = Env::default();
    let (sk1, pk1) = generate_key(&env, 11);
    let (sk2, pk2) = generate_key(&env, 12);
    let (sk3, pk3) = generate_key(&env, 13);

    let signers = Vec::from_array(&env, [pk1, pk2, pk3]);
    // Unanimous 3-of-3 configuration (threshold == signer_count)
    let contract_id = env.register(Contract, (3u32, signers, None::<u32>));
    let client = ContractClient::new(&env, &contract_id);
    assert_eq!(client.threshold(), 3);
    assert_eq!(client.signer_count(), 3);
    assert_eq!(client.threshold(), client.signer_count());

    let (hash_payload, payload_bytes) = create_payload_and_hash(&env, &[77u8; 32]);
    let sig1 = BytesN::from_array(&env, &sk1.sign(&payload_bytes).to_bytes());
    let sig2 = BytesN::from_array(&env, &sk2.sign(&payload_bytes).to_bytes());
    let sig3 = BytesN::from_array(&env, &sk3.sign(&payload_bytes).to_bytes());

    let target = Address::generate(&env);
    let auth_contexts = Vec::from_array(
        &env,
        [Context::Contract(ContractContext {
            contract: target,
            fn_name: symbol_short!("upsert"),
            args: Vec::new(&env),
        })],
    );

    // Succeeds when all 3 signers sign in strictly ascending signer_index order
    let unanimous_sigs = ThresholdSignatures {
        signatures: Vec::from_array(
            &env,
            [
                SignerSignature {
                    signer_index: 0,
                    signature: sig1.clone(),
                },
                SignerSignature {
                    signer_index: 1,
                    signature: sig2.clone(),
                },
                SignerSignature {
                    signer_index: 2,
                    signature: sig3.clone(),
                },
            ],
        ),
    };

    let ok_res = env.as_contract(&contract_id, || {
        Contract::__check_auth(
            env.clone(),
            hash_payload.clone(),
            unanimous_sigs,
            auth_contexts.clone(),
        )
    });
    assert_eq!(ok_res, Ok(()));

    // Fails when any single signer is missing (only 2 of 3 sign)
    for missing_pair in [
        [
            SignerSignature {
                signer_index: 0,
                signature: sig1.clone(),
            },
            SignerSignature {
                signer_index: 1,
                signature: sig2.clone(),
            },
        ],
        [
            SignerSignature {
                signer_index: 0,
                signature: sig1,
            },
            SignerSignature {
                signer_index: 2,
                signature: sig3.clone(),
            },
        ],
        [
            SignerSignature {
                signer_index: 1,
                signature: sig2,
            },
            SignerSignature {
                signer_index: 2,
                signature: sig3,
            },
        ],
    ] {
        let partial_sigs = ThresholdSignatures {
            signatures: Vec::from_array(&env, missing_pair),
        };
        let err_res = env.as_contract(&contract_id, || {
            Contract::__check_auth(
                env.clone(),
                hash_payload.clone(),
                partial_sigs,
                auth_contexts.clone(),
            )
        });
        assert_eq!(err_res, Err(ThresholdError::InsufficientSignatures));
    }
}

#[test]
fn test_check_auth_single_signer_threshold_one() {
    let env = Env::default();
    let (sk1, pk1) = generate_key(&env, 21);
    let (sk2, pk2) = generate_key(&env, 22);
    let (sk3, pk3) = generate_key(&env, 23);

    let signers = Vec::from_array(&env, [pk1, pk2, pk3]);
    // Boundary configuration: threshold == 1 across 3 signers
    let contract_id = env.register(Contract, (1u32, signers, None::<u32>));
    let client = ContractClient::new(&env, &contract_id);
    assert_eq!(client.threshold(), 1);

    let (hash_payload, payload_bytes) = create_payload_and_hash(&env, &[88u8; 32]);
    let sigs = [
        (0u32, BytesN::from_array(&env, &sk1.sign(&payload_bytes).to_bytes())),
        (1u32, BytesN::from_array(&env, &sk2.sign(&payload_bytes).to_bytes())),
        (2u32, BytesN::from_array(&env, &sk3.sign(&payload_bytes).to_bytes())),
    ];

    let target = Address::generate(&env);
    let auth_contexts = Vec::from_array(
        &env,
        [Context::Contract(ContractContext {
            contract: target,
            fn_name: symbol_short!("upsert"),
            args: Vec::new(&env),
        })],
    );

    // Succeeds when any single signer (index 0, 1, or 2) signs alone
    for (signer_index, signature) in sigs {
        let single_sig = ThresholdSignatures {
            signatures: Vec::from_array(
                &env,
                [SignerSignature {
                    signer_index,
                    signature,
                }],
            ),
        };
        let res = env.as_contract(&contract_id, || {
            Contract::__check_auth(
                env.clone(),
                hash_payload.clone(),
                single_sig,
                auth_contexts.clone(),
            )
        });
        assert_eq!(res, Ok(()));
    }

    // Fails when zero signatures are provided
    let empty_sigs = ThresholdSignatures {
        signatures: Vec::new(&env),
    };
    let empty_res = env.as_contract(&contract_id, || {
        Contract::__check_auth(env.clone(), hash_payload, empty_sigs, auth_contexts)
    });
    assert_eq!(empty_res, Err(ThresholdError::InsufficientSignatures));
}

