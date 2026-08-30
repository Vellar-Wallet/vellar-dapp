//! VELA passkey-escalation policy: require a second passkey confirmation for
//! flagged transactions instead of rejecting outright.
//!
//! This implements a two-phase authorization flow:
//!
//! 1. **Flag phase**: A pending escalation record is stored on-chain.
//! 2. **Approve phase**: The account owner calls `approve_escalation` with the
//!    additional passkey authorization.
//!
//! Once approved, the transaction can be re-submitted and will pass this
//! policy's check. Each escalation has an explicit deadline; expired
//! escalations are rejected.

#![no_std]

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Env, TryFromVal, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PolicyError {
    NotAllowed = 1,
    NotInstalled = 2,
    StillInstalled = 3,
    InvalidConfig = 4,
    WrongWallet = 5,
    EscalationNotFound = 6,
    EscalationExpired = 7,
    EscalationAlreadyConsumed = 8,
    UnauthorizedApprover = 9,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageKey {
    Config,
    Installed(Address),
    Escalation(Address, u64),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub wallet: Address,
    pub escalation_deadline: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Escalation {
    pub created_at: u64,
    pub expires_at: u64,
    pub consumed: bool,
    pub approver: Option<Address>,
}

#[contract]
pub struct Contract;

#[contractimpl]
impl Contract {
    pub fn __constructor(env: Env, wallet: Address, escalation_deadline: u64) {
        if escalation_deadline == 0 {
            panic_with_error!(&env, PolicyError::InvalidConfig);
        }

        env.storage().instance().set::<StorageKey, Config>(
            &StorageKey::Config,
            &Config {
                wallet,
                escalation_deadline,
            },
        );
    }

    pub fn config(env: Env) -> Config {
        load_config(&env)
    }

    pub fn request_escalation(env: Env, wallet: Address, escalation_id: u64) {
        wallet.require_auth();
        let config = load_config(&env);
        if wallet != config.wallet {
            panic_with_error!(&env, PolicyError::WrongWallet);
        }

        let now = env.ledger().timestamp();
        let escalation = Escalation {
            created_at: now,
            expires_at: now + config.escalation_deadline,
            consumed: false,
            approver: None,
        };

        let key = StorageKey::Escalation(wallet, escalation_id);
        env.storage()
            .persistent()
            .set::<StorageKey, Escalation>(&key, &escalation);
    }

    pub fn approve_escalation(
        env: Env,
        wallet: Address,
        escalation_id: u64,
        approver: Address,
    ) {
        approver.require_auth();
        let config = load_config(&env);
        if wallet != config.wallet {
            panic_with_error!(&env, PolicyError::WrongWallet);
        }

        let key = StorageKey::Escalation(wallet, escalation_id);
        let mut escalation: Escalation = env
            .storage()
            .persistent()
            .get::<StorageKey, Escalation>(&key)
            .unwrap_or_else(|| panic_with_error!(&env, PolicyError::EscalationNotFound));

        let now = env.ledger().timestamp();
        if now > escalation.expires_at {
            panic_with_error!(&env, PolicyError::EscalationExpired);
        }

        if escalation.consumed {
            panic_with_error!(&env, PolicyError::EscalationAlreadyConsumed);
        }

        escalation.consumed = true;
        escalation.approver = Some(approver);
        env.storage()
            .persistent()
            .set::<StorageKey, Escalation>(&key, &escalation);
    }

    pub fn is_escalation_approved(env: Env, wallet: Address, escalation_id: u64) -> bool {
        let key = StorageKey::Escalation(wallet, escalation_id);
        match env
            .storage()
            .persistent()
            .get::<StorageKey, Escalation>(&key)
        {
            Some(esc) => {
                let now = env.ledger().timestamp();
                esc.consumed && now <= esc.expires_at
            }
            None => false,
        }
    }

    pub fn install(env: Env, wallet: Address) {
        wallet.require_auth();
        let config = load_config(&env);
        if wallet != config.wallet {
            panic_with_error!(&env, PolicyError::WrongWallet);
        }

        let installed_key = StorageKey::Installed(wallet);
        env.storage()
            .persistent()
            .set::<StorageKey, bool>(&installed_key, &true);
    }

    pub fn policy__(env: Env, source: Address, contexts: Vec<Context>) {
        source.require_auth();

        let config = load_config(&env);
        if source != config.wallet {
            panic_with_error!(&env, PolicyError::WrongWallet);
        }

        let installed_key = StorageKey::Installed(source.clone());
        if !env.storage().persistent().has::<StorageKey>(&installed_key) {
            panic_with_error!(&env, PolicyError::NotInstalled);
        }

        for context in contexts.iter() {
            match &context {
                Context::Contract(ContractContext {
                    contract,
                    fn_name,
                    ..
                }) => {
                    if *contract == source {
                        panic_with_error!(&env, PolicyError::NotAllowed);
                    }

                    if *fn_name != symbol_short!("transfer") {
                        panic_with_error!(&env, PolicyError::NotAllowed);
                    }

                    let ctx_hash = hash_context(&env, &context);
                    let key = StorageKey::Escalation(source.clone(), ctx_hash);
                    let is_approved = env
                        .storage()
                        .persistent()
                        .get::<StorageKey, Escalation>(&key)
                        .map(|esc| {
                            let now = env.ledger().timestamp();
                            esc.consumed && now <= esc.expires_at
                        })
                        .unwrap_or(false);

                    if !is_approved {
                        panic_with_error!(&env, PolicyError::NotAllowed);
                    }
                }
                _ => panic_with_error!(&env, PolicyError::NotAllowed),
            }
        }
    }
}

pub fn hash_context(env: &Env, context: &Context) -> u64 {
    match context {
        Context::Contract(ContractContext {
            contract,
            fn_name,
            args,
        }) => {
            let mut hash: u64 = 0x6170_6f6c_6f;

            let contract_val: soroban_sdk::Val = contract.to_val();
            let contract_raw =
                unsafe { core::mem::transmute_copy::<soroban_sdk::Val, u64>(&contract_val) };
            hash = hash.wrapping_add(contract_raw);

            let fn_val: soroban_sdk::Val = fn_name.to_val();
            let fn_raw =
                unsafe { core::mem::transmute_copy::<soroban_sdk::Val, u64>(&fn_val) };
            hash = hash.wrapping_add(fn_raw.wrapping_mul(0x9E3779B97F4A7C15));

            if let Some(arg) = args.get(1) {
                if let Ok(addr) = Address::try_from_val(env, &arg) {
                    let addr_val: soroban_sdk::Val = addr.to_val();
                    let addr_raw = unsafe {
                        core::mem::transmute_copy::<soroban_sdk::Val, u64>(&addr_val)
                    };
                    hash = hash.wrapping_add(addr_raw.wrapping_mul(0x517CC1B727220A95));
                }
            }

            if let Some(arg) = args.get(2) {
                if let Ok(amount) = i128::try_from_val(env, &arg) {
                    hash = hash.wrapping_add(amount as u64);
                }
            }

            hash
        }
        _ => 0,
    }
}

fn load_config(env: &Env) -> Config {
    env.storage()
        .instance()
        .get::<StorageKey, Config>(&StorageKey::Config)
        .unwrap_or_else(|| panic_with_error!(env, PolicyError::NotInstalled))
}

#[cfg(test)]
mod test;
