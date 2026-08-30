//! VELA Safety Policy: Context-parsing authorization helper and safety rule contract.
//!
//! ## Recognized Interaction Shapes & Documentation
//!
//! This helper reads Soroban authorization contexts (`soroban_sdk::auth::Context`)
//! passed during signing and turns them into a typed `Interaction` structure.
//!
//! - **Token Transfer (`Interaction::TokenTransfer`)**: Recognized when a contract
//!   invocation calls the `transfer` function with standard SEP-41 parameters `(from, to, amount)`.
//!   The target contract, recipient address, and positive `i128` amount are extracted.
//! - **Other Contract Invocation (`Interaction::OtherContractCall`)**: Recognized for contract
//!   invocations with non-transfer function names or non-transfer parameters.
//! - **Unknown (`Interaction::Unknown`)**: Returned when context is malformed, non-contract,
//!   or unclassifiable.
//!
//! ### Scope & Limits
//!
//! This parser covers ONLY direct, top-level SEP-41 token transfer patterns.
//! It does NOT cover arbitrary nested contract calls, custom multi-hop routes, or indirect
//! value movements. Unrecognized or complex interactions are classified as `Unknown`
//! and denied by default.

#![no_std]

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Env, Symbol, TryFromVal, Vec,
};

/// Maximum context entries evaluated per authorization call to guarantee bounded work.
pub const MAX_CONTEXT_EVALUATION_LIMIT: u32 = 10;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PolicyError {
    /// Context rejected or spend limit violated.
    NotAllowed = 1,
    /// Policy not installed on wallet.
    NotInstalled = 2,
    /// Policy still attached to wallet.
    StillInstalled = 3,
    /// Invalid constructor config.
    InvalidConfig = 4,
    /// Wallet mismatch.
    WrongWallet = 5,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageKey {
    Config,
    Installed(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub wallet: Address,
    pub max_transfer_amount: i128,
}

/// Typed representation of an authorization context interaction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Interaction {
    TokenTransfer {
        contract: Address,
        to: Address,
        amount: i128,
    },
    OtherContractCall {
        contract: Address,
        fn_name: Symbol,
    },
    Unknown,
}

/// Parse a single Soroban `Context` into a typed `Interaction`.
///
/// Reads invoked contract, function name, and arguments directly from the protocol context.
pub fn parse_authorization_context(env: &Env, context: &Context) -> Interaction {
    match context {
        Context::Contract(ContractContext {
            contract,
            fn_name,
            args,
        }) => {
            if *fn_name == symbol_short!("transfer") {
                // SEP-41 transfer(from: Address, to: Address, amount: i128)
                let to_val = match args.get(1) {
                    Some(val) => val,
                    None => return Interaction::Unknown,
                };
                let to_addr = match Address::try_from_val(env, &to_val) {
                    Ok(addr) => addr,
                    Err(_) => return Interaction::Unknown,
                };

                let amount_val = match args.get(2) {
                    Some(val) => val,
                    None => return Interaction::Unknown,
                };
                let amount = match i128::try_from_val(env, &amount_val) {
                    Ok(amt) => amt,
                    Err(_) => return Interaction::Unknown,
                };

                if amount <= 0 {
                    return Interaction::Unknown;
                }

                Interaction::TokenTransfer {
                    contract: contract.clone(),
                    to: to_addr,
                    amount,
                }
            } else {
                Interaction::OtherContractCall {
                    contract: contract.clone(),
                    fn_name: fn_name.clone(),
                }
            }
        }
        _ => Interaction::Unknown,
    }
}

/// Bounded context helper that parses a list of contexts up to `MAX_CONTEXT_EVALUATION_LIMIT`.
pub fn parse_authorization_contexts(env: &Env, contexts: &Vec<Context>) -> Vec<Interaction> {
    let mut results = Vec::new(env);
    let count = contexts.len().min(MAX_CONTEXT_EVALUATION_LIMIT);
    for i in 0..count {
        if let Some(ctx) = contexts.get(i) {
            results.push_back(parse_authorization_context(env, &ctx));
        }
    }
    results
}

#[contract]
pub struct Contract;

#[contractimpl]
impl Contract {
    pub fn __constructor(env: Env, wallet: Address, max_transfer_amount: i128) {
        if max_transfer_amount <= 0 {
            panic_with_error!(&env, PolicyError::InvalidConfig);
        }
        env.storage().instance().set(
            &StorageKey::Config,
            &Config {
                wallet,
                max_transfer_amount,
            },
        );
    }

    pub fn config(env: Env) -> Config {
        env.storage()
            .instance()
            .get(&StorageKey::Config)
            .unwrap_or_else(|| panic_with_error!(&env, PolicyError::NotInstalled))
    }

    pub fn install(env: Env, wallet: Address) {
        wallet.require_auth();
        let config = Self::config(env.clone());
        if wallet != config.wallet {
            panic_with_error!(&env, PolicyError::WrongWallet);
        }
        env.storage()
            .persistent()
            .set(&StorageKey::Installed(wallet), &true);
    }

    pub fn policy__(env: Env, source: Address, contexts: Vec<Context>) {
        source.require_auth();
        let config = Self::config(env.clone());

        if source != config.wallet {
            panic_with_error!(&env, PolicyError::WrongWallet);
        }
        if !env
            .storage()
            .persistent()
            .has(&StorageKey::Installed(source.clone()))
        {
            panic_with_error!(&env, PolicyError::NotInstalled);
        }

        // Bounded evaluation of parsed interactions via parse_authorization_contexts
        let interactions = parse_authorization_contexts(&env, &contexts);
        if interactions.is_empty() {
            panic_with_error!(&env, PolicyError::NotAllowed);
        }

        for interaction in interactions.iter() {
            match interaction {
                Interaction::TokenTransfer {
                    contract: _,
                    to: _,
                    amount,
                } => {
                    if amount > config.max_transfer_amount {
                        panic_with_error!(&env, PolicyError::NotAllowed);
                    }
                }
                Interaction::OtherContractCall { .. } => {
                    // Non-transfer contract calls rejected by safety policy
                    panic_with_error!(&env, PolicyError::NotAllowed);
                }
                Interaction::Unknown => {
                    // Unknown or malformed contexts rejected
                    panic_with_error!(&env, PolicyError::NotAllowed);
                }
            }
        }
    }
}

#[cfg(test)]
mod test;
