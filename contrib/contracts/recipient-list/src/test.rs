#![cfg(test)]

extern crate std;

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contractimpl, symbol_short,
    testutils::Address as _,
    Address, Env, IntoVal, Vec,
};

use crate::{Config, Contract, ContractClient, RecipientMode};

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
    recipient: Address,
}

fn setup(mode: RecipientMode) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    let wallet = env.register(MockWallet, ());
    let policy_id = env.register(Contract, (wallet.clone(), mode));
    let policy = ContractClient::new(&env, &policy_id);
    let recipient = Address::generate(&env);
    Fixture {
        env,
        policy,
        wallet,
        recipient,
    }
}

fn transfer_ctx(env: &Env, wallet: &Address, to: &Address, amount: i128) -> Vec<Context> {
    let args: Vec<soroban_sdk::Val> = (wallet.clone(), to.clone(), amount).into_val(env);
    Vec::from_array(
        env,
        [Context::Contract(ContractContext {
            contract: Address::generate(env),
            fn_name: symbol_short!("transfer"),
            args,
        })],
    )
}

fn install(fx: &Fixture) {
    fx.policy.install(&fx.wallet);
}

#[test]
fn constructor_stores_config() {
    let fx = setup(RecipientMode::Allow);
    let config = fx.policy.config();
    assert_eq!(
        config,
        Config {
            wallet: fx.wallet.clone(),
            mode: RecipientMode::Allow,
        }
    );
}

#[test]
fn allow_mode_allows_listed_recipient() {
    let fx = setup(RecipientMode::Allow);
    install(&fx);
    fx.policy
        .add_recipient(&fx.wallet, &fx.recipient);
    fx.policy.policy__(
        &fx.wallet,
        &transfer_ctx(&fx.env, &fx.wallet, &fx.recipient, 100),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn allow_mode_rejects_unlisted_recipient() {
    let fx = setup(RecipientMode::Allow);
    install(&fx);
    let unknown = Address::generate(&fx.env);
    fx.policy.policy__(
        &fx.wallet,
        &transfer_ctx(&fx.env, &fx.wallet, &unknown, 100),
    );
}

#[test]
fn block_mode_allows_unlisted_recipient() {
    let fx = setup(RecipientMode::Block);
    install(&fx);
    let allowed = Address::generate(&fx.env);
    fx.policy.policy__(
        &fx.wallet,
        &transfer_ctx(&fx.env, &fx.wallet, &allowed, 100),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn block_mode_rejects_listed_recipient() {
    let fx = setup(RecipientMode::Block);
    install(&fx);
    fx.policy
        .add_recipient(&fx.wallet, &fx.recipient);
    fx.policy.policy__(
        &fx.wallet,
        &transfer_ctx(&fx.env, &fx.wallet, &fx.recipient, 100),
    );
}

#[test]
fn add_and_remove_recipient() {
    let fx = setup(RecipientMode::Allow);
    install(&fx);
    fx.policy
        .add_recipient(&fx.wallet, &fx.recipient);
    let list = fx.policy.get_list(&fx.wallet);
    assert_eq!(list.len(), 1);

    fx.policy
        .remove_recipient(&fx.wallet, &fx.recipient);
    let list = fx.policy.get_list(&fx.wallet);
    assert_eq!(list.len(), 0);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn list_size_limit_enforced() {
    let fx = setup(RecipientMode::Allow);
    install(&fx);
    for _ in 0..51 {
        let r = Address::generate(&fx.env);
        if r == fx.recipient {
            continue;
        }
        fx.policy
            .add_recipient(&fx.wallet, &r);
    }
}

#[test]
#[should_panic(expected = "Unauthorized")]
fn add_recipient_requires_auth() {
    let env = Env::default();
    let wallet = env.register(MockWallet, ());
    let policy_id = env.register(Contract, (wallet.clone(), RecipientMode::Allow));
    let policy = ContractClient::new(&env, &policy_id);
    let r = Address::generate(&env);
    policy.add_recipient(&wallet, &r);
}
