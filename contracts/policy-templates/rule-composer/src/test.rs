#![cfg(test)]

extern crate std;

use smart_wallet_interface::types::{SignerExpiration, SignerKey, SignerLimits, SignerVal};
use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contractimpl, symbol_short,
    testutils::Address as _,
    Address, Env, IntoVal, Symbol, Vec,
};

use crate::{Contract, ContractClient};

use soroban_sdk::panic_with_error;

// ----- Mock wallet -----
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

// ----- Mock pass-through rule: always passes -----
#[contract]
struct PassRule;

#[contractimpl]
impl PassRule {
    pub fn __constructor(_env: Env) {}

    pub fn policy__(
        _env: Env,
        _source: Address,
        _signer: SignerKey,
        _contexts: Vec<Context>,
    ) {
        // No-op: this rule always passes.
    }
}

// ----- Mock reject rule: always rejects -----
#[contract]
struct RejectRule;

#[contractimpl]
impl RejectRule {
    pub fn __constructor(_env: Env) {}

    pub fn policy__(
        env: Env,
        _source: Address,
        _signer: SignerKey,
        _contexts: Vec<Context>,
    ) {
        panic_with_error!(&env, crate::PolicyError::NotAllowed);
    }
}

// ----- Fixtures -----

struct Fixture {
    env: Env,
    composer: ContractClient<'static>,
    wallet: Address,
}

fn setup(rule_addrs: Vec<Address>) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    let wallet = env.register(MockWallet, (false,));
    let composer_id = env.register(Contract, (wallet.clone(), rule_addrs));
    let composer = ContractClient::new(&env, &composer_id);
    Fixture {
        env,
        composer,
        wallet,
    }
}

fn transfer_ctx(env: &Env, wallet: &Address) -> Vec<Context> {
    let dest = Address::generate(env);
    let args: Vec<soroban_sdk::Val> = (wallet.clone(), dest.clone(), 100_i128).into_val(env);
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
    SignerKey::Policy(fx.composer.address.clone())
}

fn install(fx: &Fixture) {
    fx.composer.install(&fx.wallet);
}

// ----- Tests -----

#[test]
fn constructor_stores_config() {
    let env = Env::default();
    let wallet = env.register(MockWallet, (false,));
    let rule = env.register(PassRule, ());
    let rules = Vec::from_array(&env, [rule.clone()]);
    let composer_id = env.register(Contract, (wallet.clone(), rules));
    let composer = ContractClient::new(&env, &composer_id);
    let config = composer.config();
    assert_eq!(config.wallet, wallet);
    assert_eq!(config.rules.len(), 1);
}

#[test]
fn all_rules_pass_authorizes() {
    let env = Env::default();
    env.mock_all_auths();
    let wallet = env.register(MockWallet, (false,));
    let rule = env.register(PassRule, ());
    let rules = Vec::from_array(&env, [rule]);
    let composer_id = env.register(Contract, (wallet.clone(), rules));
    let composer = ContractClient::new(&env, &composer_id);
    composer.install(&wallet);
    let sk = SignerKey::Policy(composer.address.clone());
    let ctx = transfer_ctx(&env, &wallet);
    composer.policy__(&wallet, &sk, &ctx);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn single_failing_rule_rejects() {
    let env = Env::default();
    env.mock_all_auths();
    let wallet = env.register(MockWallet, (false,));
    let pass = env.register(PassRule, ());
    let reject = env.register(RejectRule, ());
    let rules = Vec::from_array(&env, [pass, reject]);
    let composer_id = env.register(Contract, (wallet.clone(), rules));
    let composer = ContractClient::new(&env, &composer_id);
    composer.install(&wallet);
    let sk = SignerKey::Policy(composer.address.clone());
    let ctx = transfer_ctx(&env, &wallet);
    composer.policy__(&wallet, &sk, &ctx);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn unclassifiable_input_rejects() {
    let env = Env::default();
    env.mock_all_auths();
    let wallet = env.register(MockWallet, (false,));
    let rules: Vec<Address> = Vec::new(&env);
    let composer_id = env.register(Contract, (wallet.clone(), rules));
    let composer = ContractClient::new(&env, &composer_id);
    composer.install(&wallet);
    let sk = SignerKey::Policy(composer.address.clone());
    // Non-transfer function name — should reject (deny-by-default).
    let ctx = Vec::from_array(
        &env,
        [Context::Contract(ContractContext {
            contract: Address::generate(&env),
            fn_name: Symbol::new(&env, "swap"),
            args: (wallet.clone(), Address::generate(&env), 1_i128).into_val(&env),
        })],
    );
    composer.policy__(&wallet, &sk, &ctx);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn rule_limit_enforced() {
    let env = Env::default();
    let wallet = env.register(MockWallet, (false,));
    let mut rules = Vec::new(&env);
    for _ in 0..11 {
        let r = env.register(PassRule, ());
        rules.push_back(r);
    }
    env.register(Contract, (wallet, rules));
}
