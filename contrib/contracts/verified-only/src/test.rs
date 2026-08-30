#![cfg(test)]

use super::*;
use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contractimpl, symbol_short, vec, Address, Env, IntoVal, Symbol,
};

#[contract]
pub struct MockRegistry;

#[contractimpl]
impl MockRegistry {
    pub fn __constructor(env: Env) {}

    pub fn set_verified(env: Env, contract: Address, verified: bool) {
        env.storage().persistent().set(&contract, &verified);
    }

    pub fn is_verified(env: Env, target: Address) -> bool {
        env.storage()
            .persistent()
            .get(&target)
            .unwrap_or(false)
    }
}

fn setup_env() -> (Env, Address, Address, Address, ContractClient<'static>, MockRegistryClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();

    let wallet = Address::generate(&env);
    let registry_id = env.register(MockRegistry, ());
    let registry_client = MockRegistryClient::new(&env, &registry_id);

    let policy_id = env.register(Contract, (wallet.clone(), registry_id.clone()));
    let policy_client = ContractClient::new(&env, &policy_id);

    policy_client.install(&wallet);

    (env, wallet, registry_id, policy_id, policy_client, registry_client)
}

#[test]
fn test_verified_target_authorized() {
    let (env, wallet, _registry_id, _policy_id, policy_client, registry_client) = setup_env();

    let target_contract = Address::generate(&env);
    registry_client.set_verified(&target_contract, &true);

    let ctx = Context::Contract(ContractContext {
        contract: target_contract,
        fn_name: symbol_short!("transfer"),
        args: vec![&env],
    });

    policy_client.policy__(&wallet, &vec![&env, ctx]);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn test_unverified_target_rejected() {
    let (env, wallet, _registry_id, _policy_id, policy_client, registry_client) = setup_env();

    let unverified_target = Address::generate(&env);
    registry_client.set_verified(&unverified_target, &false);

    let ctx = Context::Contract(ContractContext {
        contract: unverified_target,
        fn_name: symbol_short!("transfer"),
        args: vec![&env],
    });

    policy_client.policy__(&wallet, &vec![&env, ctx]);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn test_unresolvable_target_rejected() {
    let (env, wallet, _registry_id, _policy_id, policy_client, _registry_client) = setup_env();

    // Context with no target contract / empty context list
    let empty_contexts: Vec<Context> = vec![&env];
    policy_client.policy__(&wallet, &empty_contexts);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn test_verified_then_revoked_target_rejected() {
    let (env, wallet, _registry_id, _policy_id, policy_client, registry_client) = setup_env();

    let target = Address::generate(&env);

    // Initially verified
    registry_client.set_verified(&target, &true);

    let ctx = Context::Contract(ContractContext {
        contract: target.clone(),
        fn_name: symbol_short!("transfer"),
        args: vec![&env],
    });

    // Succeeds while verified
    policy_client.policy__(&wallet, &vec![&env, ctx.clone()]);

    // Revoke verification in registry
    registry_client.set_verified(&target, &false);

    // Re-attempt authorization; now panics/rejects
    policy_client.policy__(&wallet, &vec![&env, ctx]);
}
