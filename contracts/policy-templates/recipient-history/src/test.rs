#![cfg(test)]

extern crate std;

use smart_wallet_interface::types::{SignerExpiration, SignerKey, SignerLimits, SignerVal};
use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger as _},
    Address, Env, IntoVal, Vec,
};

use crate::{Config, Contract, ContractClient};

#[contract]
struct MockWallet;

#[contractimpl]
impl MockWallet {
    pub fn __constructor(env: Env, still_signer: bool) {
        env.storage()
            .instance()
            .set(&symbol_short!("SIGNER"), &still_signer);
    }

    pub fn get_signer(env: Env, _signer_key: SignerKey) -> Option<SignerVal> {
        let still: bool = env
            .storage()
            .instance()
            .get(&symbol_short!("SIGNER"))
            .unwrap_or(false);
        if still {
            Some(SignerVal::Policy(
                SignerExpiration(None),
                SignerLimits(None),
            ))
        } else {
            None
        }
    }
}

struct Fixture {
    env: Env,
    policy: ContractClient<'static>,
    wallet: Address,
    recipient: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    let wallet = env.register(MockWallet, (false,));
    let policy_id = env.register(Contract, (wallet.clone(),));
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

fn signer_key(fx: &Fixture) -> SignerKey {
    SignerKey::Policy(fx.policy.address.clone())
}

fn install(fx: &Fixture) {
    fx.policy.install(&fx.wallet);
}

#[test]
fn constructor_stores_config() {
    let fx = setup();
    let config = fx.policy.config();
    assert_eq!(
        config,
        Config {
            wallet: fx.wallet.clone(),
        }
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_transfer_to_new_recipient() {
    let fx = setup();
    install(&fx);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, &fx.recipient, 100),
    );
}

#[test]
fn allows_transfer_to_known_recipient() {
    let fx = setup();
    install(&fx);
    fx.policy
        .record_recipient(&fx.wallet, &fx.recipient);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, &fx.recipient, 100),
    );
}

#[test]
fn is_known_returns_true_for_tracked_recipient() {
    let fx = setup();
    install(&fx);
    assert!(!fx.policy.is_known(&fx.wallet, &fx.recipient));
    fx.policy
        .record_recipient(&fx.wallet, &fx.recipient);
    assert!(fx.policy.is_known(&fx.wallet, &fx.recipient));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn rejects_after_entry_expires() {
    let fx = setup();
    install(&fx);
    fx.policy
        .record_recipient(&fx.wallet, &fx.recipient);
    // Advance past the 90-day TTL.
    fx.env
        .ledger()
        .set_timestamp(fx.env.ledger().timestamp() + 90 * 24 * 60 * 60);
    fx.policy.policy__(
        &fx.wallet,
        &signer_key(&fx),
        &transfer_ctx(&fx.env, &fx.wallet, &fx.recipient, 100),
    );
}
