#![cfg(test)]

use super::*;
use soroban_sdk::{
    auth::{Context, ContractContext},
    symbol_short, vec, Address, Env, IntoVal, Symbol,
};

#[test]
fn test_parse_authorization_context_direct_transfer() {
    let env = Env::default();
    let contract = Address::generate(&env);
    let from = Address::generate(&env);
    let to = Address::generate(&env);
    let amount: i128 = 500;

    let ctx = Context::Contract(ContractContext {
        contract: contract.clone(),
        fn_name: symbol_short!("transfer"),
        args: (from, to.clone(), amount).into_val(&env),
    });

    let interaction = parse_authorization_context(&env, &ctx);
    assert_eq!(
        interaction,
        Interaction::TokenTransfer {
            contract,
            to,
            amount,
        }
    );
}

#[test]
fn test_parse_authorization_context_non_transfer() {
    let env = Env::default();
    let contract = Address::generate(&env);
    let fn_name = Symbol::new(&env, "swap");

    let ctx = Context::Contract(ContractContext {
        contract: contract.clone(),
        fn_name: fn_name.clone(),
        args: vec![&env],
    });

    let interaction = parse_authorization_context(&env, &ctx);
    assert_eq!(
        interaction,
        Interaction::OtherContractCall { contract, fn_name }
    );
}

#[test]
fn test_parse_authorization_context_malformed() {
    let env = Env::default();
    let contract = Address::generate(&env);

    // transfer fn with invalid amount argument (e.g. missing args)
    let ctx = Context::Contract(ContractContext {
        contract,
        fn_name: symbol_short!("transfer"),
        args: vec![&env],
    });

    let interaction = parse_authorization_context(&env, &ctx);
    assert_eq!(interaction, Interaction::Unknown);
}

#[test]
fn test_parse_authorization_contexts_multiple() {
    let env = Env::default();
    let contract1 = Address::generate(&env);
    let contract2 = Address::generate(&env);
    let from = Address::generate(&env);
    let to = Address::generate(&env);

    let ctx1 = Context::Contract(ContractContext {
        contract: contract1.clone(),
        fn_name: symbol_short!("transfer"),
        args: (from, to.clone(), 100i128).into_val(&env),
    });

    let ctx2 = Context::Contract(ContractContext {
        contract: contract2.clone(),
        fn_name: Symbol::new(&env, "approve"),
        args: vec![&env],
    });

    let contexts = vec![&env, ctx1, ctx2];
    let parsed = parse_authorization_contexts(&env, &contexts);

    assert_eq!(parsed.len(), 2);
    assert_eq!(
        parsed.get(0).unwrap(),
        Interaction::TokenTransfer {
            contract: contract1,
            to,
            amount: 100,
        }
    );
    assert_eq!(
        parsed.get(1).unwrap(),
        Interaction::OtherContractCall {
            contract: contract2,
            fn_name: Symbol::new(&env, "approve"),
        }
    );
}

#[test]
fn test_policy_authorization_path_exercised() {
    let env = Env::default();
    env.mock_all_auths();

    let wallet = Address::generate(&env);
    let policy_id = env.register(Contract, (wallet.clone(), 1000i128));
    let client = ContractClient::new(&env, &policy_id);

    client.install(&wallet);

    let target_contract = Address::generate(&env);
    let recipient = Address::generate(&env);

    // Valid transfer within limit passes through policy__ hook
    let valid_ctx = Context::Contract(ContractContext {
        contract: target_contract,
        fn_name: symbol_short!("transfer"),
        args: (wallet.clone(), recipient, 500i128).into_val(&env),
    });

    let contexts = vec![&env, valid_ctx];
    client.policy__(&wallet, &contexts);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn test_policy_authorization_path_rejects_exceeded_limit() {
    let env = Env::default();
    env.mock_all_auths();

    let wallet = Address::generate(&env);
    let policy_id = env.register(Contract, (wallet.clone(), 1000i128));
    let client = ContractClient::new(&env, &policy_id);

    client.install(&wallet);

    let target_contract = Address::generate(&env);
    let recipient = Address::generate(&env);

    // Exceeding transfer amount panics in policy__
    let over_ctx = Context::Contract(ContractContext {
        contract: target_contract,
        fn_name: symbol_short!("transfer"),
        args: (wallet.clone(), recipient, 2000i128).into_val(&env),
    });

    let contexts = vec![&env, over_ctx];
    client.policy__(&wallet, &contexts);
}
