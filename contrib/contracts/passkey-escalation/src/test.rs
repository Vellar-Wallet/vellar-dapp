#![cfg(test)]

extern crate std;

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger as _},
    Address, Env, IntoVal, Vec,
};

use crate::{Contract, ContractClient};

#[contract]
struct MockWallet;

#[contractimpl]
impl MockWallet {
    pub fn __constructor(_env: Env) {}
}

struct Fixture {
    env: Env,
    policy: ContractClient<'static>,
    wallet: Address,
    approver: Address,
}

const HOUR: u64 = 3600;

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    let wallet = env.register(MockWallet, ());
    let policy_id = env.register(Contract, (wallet.clone(), HOUR));
    let policy = ContractClient::new(&env, &policy_id);
    let approver = Address::generate(&env);
    Fixture {
        env,
        policy,
        wallet,
        approver,
    }
}

fn make_transfer_context(env: &Env, wallet: &Address) -> (Vec<Context>, u64) {
    let dest = Address::generate(env);
    let args: Vec<soroban_sdk::Val> = (wallet.clone(), dest.clone(), 100_i128).into_val(env);
    let ctx = Vec::from_array(
        env,
        [Context::Contract(ContractContext {
            contract: Address::generate(env),
            fn_name: symbol_short!("transfer"),
            args,
        })],
    );
    let esc_id = crate::hash_context(env, &ctx.get(0).unwrap());
    (ctx, esc_id)
}

fn install(fx: &Fixture) {
    fx.policy.install(&fx.wallet);
}

#[test]
fn constructor_stores_config() {
    let fx = setup();
    let config = fx.policy.config();
    assert_eq!(config.escalation_deadline, HOUR);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_zero_deadline() {
    let env = Env::default();
    let wallet = env.register(MockWallet, ());
    env.register(Contract, (wallet, 0_u64));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_transfer_without_escalation() {
    let fx = setup();
    install(&fx);
    let (ctx, _) = make_transfer_context(&fx.env, &fx.wallet);
    fx.policy.policy__(&fx.wallet, &ctx);
}

#[test]
fn allows_transfer_with_approved_escalation() {
    let fx = setup();
    install(&fx);
    let (ctx, esc_id) = make_transfer_context(&fx.env, &fx.wallet);
    fx.policy
        .request_escalation(&fx.wallet, &esc_id);
    fx.policy
        .approve_escalation(&fx.wallet, &esc_id, &fx.approver);
    fx.policy.policy__(&fx.wallet, &ctx);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn rejects_nonexistent_escalation() {
    let fx = setup();
    install(&fx);
    let (_ctx, _) = make_transfer_context(&fx.env, &fx.wallet);
    fx.policy
        .approve_escalation(&fx.wallet, &999, &fx.approver);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_expired_escalation() {
    let fx = setup();
    install(&fx);
    let (ctx, esc_id) = make_transfer_context(&fx.env, &fx.wallet);
    fx.policy
        .request_escalation(&fx.wallet, &esc_id);
    fx.policy
        .approve_escalation(&fx.wallet, &esc_id, &fx.approver);
    fx.env
        .ledger()
        .set_timestamp(fx.env.ledger().timestamp() + HOUR + 1);
    fx.policy.policy__(&fx.wallet, &ctx);
}

#[test]
fn is_escalation_approved_returns_correct_status() {
    let fx = setup();
    install(&fx);
    let (_, esc_id) = make_transfer_context(&fx.env, &fx.wallet);

    assert!(!fx.policy.is_escalation_approved(&fx.wallet, &esc_id));

    fx.policy
        .request_escalation(&fx.wallet, &esc_id);
    assert!(!fx.policy.is_escalation_approved(&fx.wallet, &esc_id));

    fx.policy
        .approve_escalation(&fx.wallet, &esc_id, &fx.approver);
    assert!(fx.policy.is_escalation_approved(&fx.wallet, &esc_id));

    fx.env
        .ledger()
        .set_timestamp(fx.env.ledger().timestamp() + HOUR + 1);
    assert!(!fx.policy.is_escalation_approved(&fx.wallet, &esc_id));
}
