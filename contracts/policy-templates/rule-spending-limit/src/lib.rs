//! VELA rule-based spending-limit policy: a CUMULATIVE rolling-window
//! allowance that counts every call matching a configured SPEND RULE, not just
//! SEP-41 `transfer`s.
//!
//! `spending-limit` and `token-spending-limit` recognize exactly one spend
//! shape, `transfer(from, to, amount)`. Some integrations debit the wallet
//! through a different call (for example an x402 verifier's `commit`, which
//! spends a prepaid balance without moving tokens). Under the older policies
//! such a call is either hard-rejected or, if the signer has no policy, runs
//! uncapped. This variant generalizes "what counts as a spend" while keeping
//! every other invariant of the family unchanged.
//!
//! ## Spend rules
//!
//! Config holds a bounded list of [`SpendRule`]s, each naming:
//!
//!   * the exact `contract` being called,
//!   * the exact `fn_name` invoked on it, and
//!   * where the amount lives (`AmountSource`, currently `I128Arg(index)`).
//!
//! A context is a spend only if its `(contract, fn_name)` pair matches a rule
//! exactly. Matching on `fn_name` alone is never done: a rule is pinned to a
//! contract address, so a lookalike contract exposing a function with the same
//! name cannot be waved through. SEP-41 `transfer` is just another rule
//! (`amount = I128Arg(2)`).
//!
//! ## Deny-by-default (unchanged)
//!
//! Anything that is not a matching spend rule fails the WHOLE authorization:
//! non-matching calls, non-contract contexts, calls to the wallet itself, a
//! missing or non-i128 amount argument, and non-positive amounts. Rules extend
//! what counts as a spend; they never add a way to pass without being counted.
//!
//! ## One cap, one unit
//!
//! All matching amounts are summed into a single cap. The constructor cannot
//! know a rule's unit, so the DEPLOYER must only configure rules whose amounts
//! are in the same base units (e.g. USDC stroops for both the USDC `transfer`
//! and the verifier `commit`). Mixed-unit rules would make the cap meaningless;
//! deploy a separate instance per unit instead.
//!
//! ## What a rule cannot see
//!
//! A rule trusts the amount it extracts and does not inspect `payTo` or any
//! other argument. `I128Arg` reads a typed i128 argument. `TextLineArg` reads a
//! decimal integer out of one line of a String argument, for calls (such as an
//! x402 verifier's `commit(payer, commitment_text)`) that carry the amount only
//! inside a signed text. Any other encoding needs a new `AmountSource` variant
//! (a new wasm), which is why the enum is the extension point.
//!
//! ## Authorizations that are never submitted
//!
//! Some integrations only SIMULATE the signed call and never send it on-chain
//! (the x402 verifier is used this way). A simulated `__check_auth` runs this
//! policy but its storage writes are discarded, so the cumulative window cannot
//! accumulate across such calls: for them the cap acts as a PER-CALL ceiling.
//! The cumulative guarantee holds only for spends that actually land on-chain.
//!
//! ## Everything else (as in `token-spending-limit`)
//!
//! Cumulative FIXED (tumbling) window: bound is `daily_limit` per window and at
//! most `2 * daily_limit` across a boundary. Config is immutable (deploy-once,
//! no setter; raising the cap means deploying a new instance and re-attaching
//! it with a passkey approval). Single-tenant (bound to one wallet at deploy).
//! `source.require_auth()` before touching per-wallet state, checked arithmetic,
//! TTL renewal, and permissionless self-clean `uninstall`.

#![no_std]

use smart_wallet_interface::{types::SignerKey, PolicyInterface, SmartWalletClient};
use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contracterror, contractimpl, contracttype, panic_with_error, Address, Env,
    String as SorobanString, Symbol, TryFromVal, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PolicyError {
    /// A context is not a matching spend rule (deny-by-default), its amount is
    /// unreadable or non-positive, or the cumulative window allowance would be
    /// exceeded.
    NotAllowed = 1,
    /// `policy__` was called for a wallet that never installed this policy.
    NotInstalled = 2,
    /// `uninstall` was called while this policy is still a signer on the wallet.
    StillInstalled = 3,
    /// Constructor was given an out-of-range configuration value.
    InvalidConfig = 4,
    /// `install`/`policy__` was called by a wallet other than the one this
    /// instance was configured (bound) for at deploy time.
    WrongWallet = 5,
}

/// Bounds on the configurable window (same sanity guards as the rest of the
/// family; a window over a year is almost certainly a units mistake).
const MIN_ALLOWANCE: i128 = 1;
const MIN_WINDOW_SECONDS: u64 = 1;
const MAX_WINDOW_SECONDS: u64 = 60 * 60 * 24 * 365;

/// Bounds on the rule list. `policy__` does a linear scan per context, so the
/// list is capped to keep the per-check cost bounded. The argument-index cap
/// rejects obvious typos at deploy time; contracts take few arguments.
const MAX_RULES: u32 = 8;
const MAX_ARG_INDEX: u32 = 15;

/// Bounds for `TextLineArg`: the text argument is copied into a fixed stack
/// buffer to be parsed, so longer texts are rejected (fail closed). The x402
/// commitment text is about 420 bytes.
const MAX_TEXT_LEN: usize = 1024;
const MAX_PREFIX_LEN: usize = 32;

/// TTL renewal parameters (in ledgers at the historical 5s close time): bump to
/// ~30 days whenever remaining TTL drops below ~1 week.
const RENEW_THRESHOLD: u32 = 60 * 60 * 24 / 5 * 7;
const RENEW_TO: u32 = 60 * 60 * 24 / 5 * 30;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StorageKey {
    /// Immutable per-instance configuration, written once by the constructor.
    Config,
    /// Marker that `wallet` completed `install`.
    Installed(Address),
    /// Per-wallet cumulative-spend accounting for the current window.
    Spend(Address),
}

/// Where a matched call carries its amount. A new decoding (for example parsing
/// an amount out of a bytes argument) is a new variant, never a reinterpretation
/// of an existing one.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AmountSource {
    /// The amount is the call argument at this index, encoded as an i128.
    I128Arg(u32),
    /// The amount is a decimal integer on one line of the String argument at
    /// `.0`: the line must start with the prefix `.1` (for example
    /// `"amount: "`), appear EXACTLY once, and hold only canonical digits (no
    /// sign, no leading zeros, nothing after the digits). The text must fit in
    /// `MAX_TEXT_LEN` bytes.
    TextLineArg(u32, SorobanString),
}

/// One recognized spend shape: calling `fn_name` on `contract` debits the
/// wallet by the amount found per `amount`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpendRule {
    pub contract: Address,
    pub fn_name: Symbol,
    pub amount: AmountSource,
}

/// Immutable configuration set at deploy time.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    /// The single wallet this instance is bound to.
    pub wallet: Address,
    /// The calls that count as spends. Everything else is rejected.
    pub rules: Vec<SpendRule>,
    /// Cumulative amount (in the rules' shared base units) authorized per window.
    pub daily_limit: i128,
    /// Rolling-window length in seconds.
    pub window_seconds: u64,
}

/// Per-wallet cumulative-spend accounting for the current window.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Allowance {
    pub window_start: u64,
    pub spent: i128,
}

#[contract]
pub struct Contract;

#[contractimpl]
impl Contract {
    /// Deploy-time configuration. Runs exactly once (CAP-0058 constructor);
    /// there is no other path to write `Config`, so wallet, rules, limit and
    /// window are immutable for the life of the instance.
    ///
    /// `rules` must be non-empty (an empty list would reject every call), at
    /// most `MAX_RULES` long, free of duplicate `(contract, fn_name)` pairs, and
    /// must not target the wallet itself. Argument indexes are range-checked.
    pub fn __constructor(
        env: Env,
        wallet: Address,
        rules: Vec<SpendRule>,
        daily_limit: i128,
        window_seconds: u64,
    ) {
        if daily_limit < MIN_ALLOWANCE {
            panic_with_error!(&env, PolicyError::InvalidConfig);
        }
        if window_seconds < MIN_WINDOW_SECONDS || window_seconds > MAX_WINDOW_SECONDS {
            panic_with_error!(&env, PolicyError::InvalidConfig);
        }
        if rules.is_empty() || rules.len() > MAX_RULES {
            panic_with_error!(&env, PolicyError::InvalidConfig);
        }

        for (i, rule) in rules.iter().enumerate() {
            if rule.contract == wallet {
                panic_with_error!(&env, PolicyError::InvalidConfig);
            }
            match rule.amount {
                AmountSource::I128Arg(index) => {
                    if index > MAX_ARG_INDEX {
                        panic_with_error!(&env, PolicyError::InvalidConfig);
                    }
                }
                AmountSource::TextLineArg(index, prefix) => {
                    let len = prefix.len() as usize;
                    if index > MAX_ARG_INDEX || len == 0 || len > MAX_PREFIX_LEN {
                        panic_with_error!(&env, PolicyError::InvalidConfig);
                    }
                    // A prefix containing a line break could never match a line.
                    let mut buf = [0u8; MAX_PREFIX_LEN];
                    prefix.copy_into_slice(&mut buf[..len]);
                    if buf[..len].contains(&b'\n') {
                        panic_with_error!(&env, PolicyError::InvalidConfig);
                    }
                }
            }
            for earlier in rules.iter().take(i) {
                if earlier.contract == rule.contract && earlier.fn_name == rule.fn_name {
                    panic_with_error!(&env, PolicyError::InvalidConfig);
                }
            }
        }

        env.storage().instance().set::<StorageKey, Config>(
            &StorageKey::Config,
            &Config {
                wallet,
                rules,
                daily_limit,
                window_seconds,
            },
        );

        renew_instance(&env);
    }

    /// Read the immutable configuration (wallet, rules, limit, window). A
    /// read-only view for clients and tests; no auth required.
    pub fn config(env: Env) -> Config {
        load_config(&env)
    }
}

#[contractimpl]
impl PolicyInterface for Contract {
    fn install(env: Env, wallet: Address) {
        // The wallet is the direct invoker during add_signer; invoker auth.
        wallet.require_auth();

        // Single-tenant: refuse to install on any wallet other than the one this
        // instance was configured for. A hard panic here aborts the wallet's
        // add_signer, so a misdirected attach fails cleanly.
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
        // Permissionless: clear per-wallet state only once this policy is
        // genuinely no longer a signer on `wallet`. The wallet's get_signer is a
        // read-only view; a griefer cannot clear state for a wallet where this
        // policy is still installed.
        let still_signer = SmartWalletClient::new(&env, &wallet)
            .get_signer(&SignerKey::Policy(env.current_contract_address()))
            .is_some();

        if still_signer {
            panic_with_error!(&env, PolicyError::StillInstalled);
        }

        env.storage()
            .persistent()
            .remove::<StorageKey>(&StorageKey::Installed(wallet.clone()));
        env.storage()
            .persistent()
            .remove::<StorageKey>(&StorageKey::Spend(wallet));
    }

    fn policy__(env: Env, source: Address, _signer: SignerKey, contexts: Vec<Context>) {
        // Authenticate the caller really is the wallet before touching any
        // per-wallet state. Satisfied by invoker auth during __check_auth.
        source.require_auth();

        let config = load_config(&env);

        // Single-tenant: this instance only authorizes for its bound wallet.
        if source != config.wallet {
            panic_with_error!(&env, PolicyError::WrongWallet);
        }

        let installed_key = StorageKey::Installed(source.clone());
        if !env.storage().persistent().has::<StorageKey>(&installed_key) {
            panic_with_error!(&env, PolicyError::NotInstalled);
        }

        // An empty authorization authorizes nothing; refuse rather than
        // rubber-stamp a vacuous auth.
        if contexts.is_empty() {
            panic_with_error!(&env, PolicyError::NotAllowed);
        }

        // Deny-by-default. Every context must match a spend rule; the matched
        // amounts are summed. Anything else fails the whole authorization.
        let mut total: i128 = 0;
        for context in contexts.iter() {
            match context {
                Context::Contract(ContractContext {
                    contract,
                    fn_name,
                    args,
                }) => {
                    // Never authorize the wallet's own admin surface
                    // (add/update/remove/upgrade). `source` is the wallet.
                    if contract == source {
                        panic_with_error!(&env, PolicyError::NotAllowed);
                    }

                    let rule = match config
                        .rules
                        .iter()
                        .find(|rule| rule.contract == contract && rule.fn_name == fn_name)
                    {
                        Some(rule) => rule,
                        None => panic_with_error!(&env, PolicyError::NotAllowed),
                    };

                    // Fail closed if the amount argument is missing or not an
                    // i128.
                    let amount = match rule.amount {
                        AmountSource::I128Arg(index) => {
                            args.get(index).and_then(|v| i128::try_from_val(&env, &v).ok())
                        }
                        AmountSource::TextLineArg(index, prefix) => args
                            .get(index)
                            .and_then(|v| SorobanString::try_from_val(&env, &v).ok())
                            .and_then(|text| amount_from_text_line(&text, &prefix)),
                    };
                    let amount = match amount {
                        Some(amount) => amount,
                        None => panic_with_error!(&env, PolicyError::NotAllowed),
                    };

                    if amount <= 0 {
                        panic_with_error!(&env, PolicyError::NotAllowed);
                    }

                    total = match total.checked_add(amount) {
                        Some(total) => total,
                        None => panic_with_error!(&env, PolicyError::NotAllowed),
                    };
                }
                // Non-contract contexts (deploys, etc.) are never permitted.
                _ => panic_with_error!(&env, PolicyError::NotAllowed),
            }
        }

        // Cumulative rolling-window allowance. Load the wallet's spend record,
        // resetting it if the window has elapsed, and reject if this invocation
        // would push cumulative spend over the configured cap.
        let now = env.ledger().timestamp();
        let spend_key = StorageKey::Spend(source.clone());
        let mut allowance = env
            .storage()
            .persistent()
            .get::<StorageKey, Allowance>(&spend_key)
            .unwrap_or(Allowance {
                window_start: now,
                spent: 0,
            });

        if now.saturating_sub(allowance.window_start) >= config.window_seconds {
            allowance.window_start = now;
            allowance.spent = 0;
        }

        let new_spent = match allowance.spent.checked_add(total) {
            Some(new_spent) => new_spent,
            None => panic_with_error!(&env, PolicyError::NotAllowed),
        };

        if new_spent > config.daily_limit {
            panic_with_error!(&env, PolicyError::NotAllowed);
        }

        allowance.spent = new_spent;
        env.storage()
            .persistent()
            .set::<StorageKey, Allowance>(&spend_key, &allowance);

        // Keep this policy and its per-wallet state alive for as long as it is
        // actively authorizing.
        renew_instance(&env);
        renew_persistent(&env, &installed_key);
        renew_persistent(&env, &spend_key);
    }
}

/// Parse the amount from the single line of `text` that starts with `prefix`.
/// `None` (fail closed) if the text is too long, the prefix is absent or appears
/// on more than one line, or what follows it is not a canonical non-negative
/// decimal integer filling the rest of the line.
fn amount_from_text_line(text: &SorobanString, prefix: &SorobanString) -> Option<i128> {
    let text_len = text.len() as usize;
    let prefix_len = prefix.len() as usize;
    if text_len > MAX_TEXT_LEN || prefix_len == 0 || prefix_len > MAX_PREFIX_LEN {
        return None;
    }
    let mut text_buf = [0u8; MAX_TEXT_LEN];
    let mut prefix_buf = [0u8; MAX_PREFIX_LEN];
    text.copy_into_slice(&mut text_buf[..text_len]);
    prefix.copy_into_slice(&mut prefix_buf[..prefix_len]);
    let (text, prefix) = (&text_buf[..text_len], &prefix_buf[..prefix_len]);

    let mut found: Option<&[u8]> = None;
    for line in text.split(|b| *b == b'\n') {
        if line.starts_with(prefix) {
            if found.is_some() {
                return None; // ambiguous: the prefix appears on two lines
            }
            found = Some(&line[prefix.len()..]);
        }
    }
    parse_canonical_i128(found?)
}

/// Digits only, non-empty, no leading zero (except the single digit `0`), and
/// within i128 range.
fn parse_canonical_i128(digits: &[u8]) -> Option<i128> {
    if digits.is_empty() || (digits.len() > 1 && digits[0] == b'0') {
        return None;
    }
    let mut value: i128 = 0;
    for byte in digits {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value.checked_mul(10)?.checked_add((byte - b'0') as i128)?;
    }
    Some(value)
}

fn load_config(env: &Env) -> Config {
    env.storage()
        .instance()
        .get::<StorageKey, Config>(&StorageKey::Config)
        // A deployed instance always ran its constructor, so this is unreachable
        // in practice; fail closed rather than unwrap-panic opaquely.
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
