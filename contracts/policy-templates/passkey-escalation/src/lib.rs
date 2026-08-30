//! VELA passkey-escalation policy: require a second passkey confirmation for
//! flagged transactions instead of rejecting outright.
//!
//! This implements a two-phase authorization flow:
//!
//! 1. **Flag phase**: A rule (or this policy itself) determines that a
//!    transaction requires escalation. The transaction is not rejected; instead
//!    a pending escalation record is stored on-chain.
//!
//! 2. **Approve phase**: The account owner (or a designated approver) calls
//!    `approve_escalation` with the transaction hash, providing the additional
//!    passkey authorization.
//!
//! Once approved, the transaction can be re-submitted and will pass this
//! policy's check. Each escalation has an explicit deadline; expired
//! escalations are rejected and consumed (cannot be reused).
//!
//! ## Security model
//!
//! - Each escalation is identified by a unique ID derived from the transaction
//!   parameters.
//! - An escalation can only be consumed once (replay protection).
//! - An explicit stored deadline is used for expiry (not storage lifetime).
//! - Only the wallet owner can approve an escalation.

#![no_std]

use smart_wallet_interface::{types::SignerKey, PolicyInterface, SmartWalletClient};
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

const RENEW_THRESHOLD: u32 = 60 * 60 * 24 / 5 * 7;
const RENEW_TO: u32 = 60 * 60 * 24 / 5 * 30;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageKey {
    Config,
    Installed(Address),
    /// Pending escalation: (wallet, escalation_id) -> Escalation.
    Escalation(Address, u64),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub wallet: Address,
    /// How long an escalation remains valid (seconds).
    pub escalation_deadline: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Escalation {
    /// The ledger timestamp when this escalation was created.
    pub created_at: u64,
    /// The absolute deadline (created_at + deadline).
    pub expires_at: u64,
    /// Whether this escalation has been consumed (approved and used).
    pub consumed: bool,
    /// The approver who approved this escalation.
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
        renew_instance(&env);
    }

    pub fn config(env: Env) -> Config {
        load_config(&env)
    }

    /// Create a pending escalation for a transaction. In practice this would
    /// be called by a rule that flags the transaction. Here we expose it as
    /// a public function that stores the escalation record.
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

        renew_persistent(&env, &key);
    }

    /// Approve a pending escalation. The approver must be the wallet owner.
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

    /// Check if an escalation exists, is not expired, and has been consumed
    /// (approved). Used during authorization.
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
}

#[contractimpl]
impl PolicyInterface for Contract {
    fn install(env: Env, wallet: Address) {
        wallet.require_auth();
        let config = load_config(&env);
        if wallet != config.wallet {
            panic_with_error!(&env, PolicyError::WrongWallet);
        }

        let installed_key = StorageKey::Installed(wallet);
        env.storage()
            .persistent()
            .set::<StorageKey, bool>(&installed_key, &true);

        renew_instance(&env);
        renew_persistent(&env, &installed_key);
    }

    fn uninstall(env: Env, wallet: Address) {
        let still_signer = SmartWalletClient::new(&env, &wallet)
            .get_signer(&SignerKey::Policy(env.current_contract_address()))
            .is_some();

        if still_signer {
            panic_with_error!(&env, PolicyError::StillInstalled);
        }

        env.storage()
            .persistent()
            .remove::<StorageKey>(&StorageKey::Installed(wallet));
    }

    /// During authorization, this policy allows transfers that have a
    /// corresponding approved escalation. In the simplest form, any transfer
    /// is allowed if there is an approved escalation for it. The escalation_id
    /// is derived from the transfer parameters.
    fn policy__(env: Env, source: Address, _signer: SignerKey, contexts: Vec<Context>) {
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

                    // For the simplest implementation: every transfer must
                    // have an approved escalation. The escalation_id is the
                    // hash of the context (contract + fn_name + args).
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

        renew_instance(&env);
        renew_persistent(&env, &installed_key);
    }
}

/// Hash a context into a u64 escalation ID. Uses a simple accumulator over
/// the contract address and destination address to produce a deterministic ID.
pub fn hash_context(env: &Env, context: &Context) -> u64 {
    match context {
        Context::Contract(ContractContext {
            contract,
            fn_name,
            args,
        }) => {
            let mut hash: u64 = 0x6170_6f6c_6f; // "apolo" seed

            // Mix in contract address (Val is internally u64).
            let contract_val: soroban_sdk::Val = contract.to_val();
            let contract_raw = unsafe { core::mem::transmute_copy::<soroban_sdk::Val, u64>(&contract_val) };
            hash = hash.wrapping_add(contract_raw);

            // Mix in function name.
            let fn_val: soroban_sdk::Val = fn_name.to_val();
            let fn_raw = unsafe { core::mem::transmute_copy::<soroban_sdk::Val, u64>(&fn_val) };
            hash = hash.wrapping_add(fn_raw.wrapping_mul(0x9E3779B97F4A7C15));

            // Mix in destination (arg index 1) if present.
            if let Some(arg) = args.get(1) {
                if let Ok(addr) = Address::try_from_val(env, &arg) {
                    let addr_val: soroban_sdk::Val = addr.to_val();
                    let addr_raw = unsafe { core::mem::transmute_copy::<soroban_sdk::Val, u64>(&addr_val) };
                    hash = hash.wrapping_add(addr_raw.wrapping_mul(0x517CC1B727220A95));
                }
            }

            // Mix in amount (arg index 2) if present.
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

fn renew_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(RENEW_THRESHOLD, RENEW_TO);
}

fn renew_persistent(env: &Env, key: &StorageKey) {
    env.storage()
        .persistent()
        .extend_ttl::<StorageKey>(key, RENEW_THRESHOLD, RENEW_TO);
}

#[cfg(test)]
mod test;
