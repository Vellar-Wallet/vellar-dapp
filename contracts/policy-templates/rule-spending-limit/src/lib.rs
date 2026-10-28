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
//! ## Amount sources
//!
//! `I128Arg` reads a typed i128 argument. `TextLineArg` reads a decimal integer
//! out of one line of a String argument, for calls (such as an x402 verifier's
//! `commit(payer, commitment_text)`) that carry the amount only inside a signed
//! text. Any other encoding needs a new `AmountSource` variant (a new wasm),
//! which is why the enum is the extension point.
//!
//! ## Tightening a rule (all optional, all fail closed)
//!
//! A bare amount rule trusts whatever else the call carries. Two optional
//! fields narrow what a rule accepts, so the cap only covers the exact spend
//! shape the deployer intended:
//!
//!   * `payer_arg`: the argument at this index must be an Address equal to the
//!     wallet itself (the `payer` of `commit`, the `from` of `transfer`).
//!   * `text_guards` (only on `TextLineArg` rules), checked against the same
//!     text the amount is read from:
//!       - `FirstLine(s)`: the first line must equal `s` exactly (the format
//!         header, for example `x402 batch-settlement commitment`);
//!       - `LineOneOf(prefix, values)`: exactly one line may start with
//!         `prefix`, and the rest of that line must equal one of `values`
//!         (for example `network: ` -> `stellar:testnet`, or `payTo: ` -> an
//!         allowlist of vault addresses).
//!
//! The guards read the SAME text the amount is read from, so a signed text
//! cannot pass the guards with one set of lines and the amount with another:
//! a duplicated guarded line fails the whole call.
//!
//! What a rule still cannot see: any argument or text line that no guard
//! names. Guard every line whose value matters.
//!
//! ## Authorizations that are never submitted
//!
//! Some integrations only SIMULATE the signed call and never send it on-chain
//! (the x402 verifier is used this way). A simulated `__check_auth` runs this
//! policy but its storage writes are discarded, so the cumulative window cannot
//! accumulate across such calls: for them the cap acts as a PER-CALL ceiling.
//! The cumulative guarantee holds only for spends that actually land on-chain.
//!
//! For Fermah specifically this is a secondary layer, not the only cap: the
//! Fermah vault enforces a real cumulative daily cap per buyer, on-chain and
//! at `/settle` (an `above_spending_limit` refusal), set by the buyer at
//! deposit. This policy adds a per-call ceiling and, with the guards above,
//! pins what a commit may be (verifier, wallet as payer, network, payee).
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

/// Bounds for `TextGuard`s. Guard strings are copied into fixed buffers, so
/// they are length-capped (a Stellar strkey is 56 bytes; 128 leaves room).
const MAX_GUARDS: u32 = 8;
const MAX_GUARD_VALUES: u32 = 8;
const MAX_GUARD_LEN: usize = 128;

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

/// An exact-match requirement on the text a `TextLineArg` rule reads its
/// amount from. A violated guard fails the whole authorization.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TextGuard {
    /// The first line (everything before the first `\n`) equals this exactly.
    FirstLine(SorobanString),
    /// Exactly one line starts with `.0`, and the rest of that line equals one
    /// of the values in `.1`.
    LineOneOf(SorobanString, Vec<SorobanString>),
}

/// One recognized spend shape: calling `fn_name` on `contract` debits the
/// wallet by the amount found per `amount`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpendRule {
    pub contract: Address,
    pub fn_name: Symbol,
    pub amount: AmountSource,
    /// If set, the argument at this index must be an Address equal to the
    /// wallet itself (the payer / `from`). `None` skips the check.
    pub payer_arg: Option<u32>,
    /// Extra requirements on the text argument. Must be empty unless `amount`
    /// is `TextLineArg`.
    pub text_guards: Vec<TextGuard>,
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
            match &rule.amount {
                AmountSource::I128Arg(index) => {
                    if *index > MAX_ARG_INDEX {
                        panic_with_error!(&env, PolicyError::InvalidConfig);
                    }
                }
                AmountSource::TextLineArg(index, prefix) => {
                    if *index > MAX_ARG_INDEX || !is_valid_line_text::<MAX_PREFIX_LEN>(prefix) {
                        panic_with_error!(&env, PolicyError::InvalidConfig);
                    }
                    if !valid_text_guards(&rule.text_guards) {
                        panic_with_error!(&env, PolicyError::InvalidConfig);
                    }
                }
            }
            if matches!(rule.amount, AmountSource::I128Arg(_)) && !rule.text_guards.is_empty() {
                panic_with_error!(&env, PolicyError::InvalidConfig);
            }
            if matches!(rule.payer_arg, Some(index) if index > MAX_ARG_INDEX) {
                panic_with_error!(&env, PolicyError::InvalidConfig);
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

                    // The payer argument must be the wallet itself.
                    if let Some(index) = rule.payer_arg {
                        let payer = args
                            .get(index)
                            .and_then(|v| Address::try_from_val(&env, &v).ok());
                        if payer != Some(source.clone()) {
                            panic_with_error!(&env, PolicyError::NotAllowed);
                        }
                    }

                    // Fail closed if the amount argument is missing or not an
                    // i128 (or, for text rules, a guard or the amount line fails).
                    let amount = match rule.amount {
                        AmountSource::I128Arg(index) => {
                            args.get(index).and_then(|v| i128::try_from_val(&env, &v).ok())
                        }
                        AmountSource::TextLineArg(index, prefix) => args
                            .get(index)
                            .and_then(|v| SorobanString::try_from_val(&env, &v).ok())
                            .and_then(|text| amount_from_text(&text, &prefix, &rule.text_guards)),
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

/// A fixed-capacity copy of a Soroban string, for byte comparisons in no_std.
struct Buf<const N: usize> {
    bytes: [u8; N],
    len: usize,
}

impl<const N: usize> Buf<N> {
    /// `None` if the string does not fit.
    fn load(s: &SorobanString) -> Option<Self> {
        let len = s.len() as usize;
        if len > N {
            return None;
        }
        let mut bytes = [0u8; N];
        s.copy_into_slice(&mut bytes[..len]);
        Some(Buf { bytes, len })
    }

    fn as_slice(&self) -> &[u8] {
        &self.bytes[..self.len]
    }
}

/// Non-empty, fits in `N` bytes, and contains no line break (so it can match
/// within a single line).
fn is_valid_line_text<const N: usize>(s: &SorobanString) -> bool {
    match Buf::<N>::load(s) {
        Some(buf) => !buf.as_slice().is_empty() && !buf.as_slice().contains(&b'\n'),
        None => false,
    }
}

/// Constructor check for a rule's guards: bounded, well-formed, and not
/// self-contradictory (at most one `FirstLine`, no repeated `LineOneOf` prefix).
fn valid_text_guards(guards: &Vec<TextGuard>) -> bool {
    if guards.len() > MAX_GUARDS {
        return false;
    }
    let mut first_lines = 0u32;
    for (i, guard) in guards.iter().enumerate() {
        match guard {
            TextGuard::FirstLine(expected) => {
                first_lines += 1;
                if first_lines > 1 || !is_valid_line_text::<MAX_GUARD_LEN>(&expected) {
                    return false;
                }
            }
            TextGuard::LineOneOf(prefix, values) => {
                if !is_valid_line_text::<MAX_PREFIX_LEN>(&prefix)
                    || values.is_empty()
                    || values.len() > MAX_GUARD_VALUES
                    || !values.iter().all(|v| is_valid_line_text::<MAX_GUARD_LEN>(&v))
                {
                    return false;
                }
                for earlier in guards.iter().take(i) {
                    if matches!(earlier, TextGuard::LineOneOf(p, _) if p == prefix) {
                        return false;
                    }
                }
            }
        }
    }
    true
}

/// The remainder of the single line of `text` that starts with `prefix`. `None`
/// if no line has the prefix or more than one does (ambiguous: never pick one).
fn unique_line_value<'a>(text: &'a [u8], prefix: &[u8]) -> Option<&'a [u8]> {
    let mut found: Option<&[u8]> = None;
    for line in text.split(|b| *b == b'\n') {
        if line.starts_with(prefix) {
            if found.is_some() {
                return None;
            }
            found = Some(&line[prefix.len()..]);
        }
    }
    found
}

/// Whether `text` satisfies one guard. Fails closed on oversized guard config.
fn guard_holds(text: &[u8], guard: &TextGuard) -> bool {
    match guard {
        TextGuard::FirstLine(expected) => match Buf::<MAX_GUARD_LEN>::load(expected) {
            Some(expected) => text.split(|b| *b == b'\n').next() == Some(expected.as_slice()),
            None => false,
        },
        TextGuard::LineOneOf(prefix, values) => {
            let prefix = match Buf::<MAX_PREFIX_LEN>::load(prefix) {
                Some(prefix) => prefix,
                None => return false,
            };
            let value = match unique_line_value(text, prefix.as_slice()) {
                Some(value) => value,
                None => return false,
            };
            values.iter().any(|candidate| {
                Buf::<MAX_GUARD_LEN>::load(&candidate)
                    .is_some_and(|candidate| candidate.as_slice() == value)
            })
        }
    }
}

/// Check every guard against `text`, then parse the amount from the single line
/// that starts with `prefix`. `None` (fail closed) if the text is too long, a
/// guard fails, the prefix is absent or on more than one line, or what follows
/// it is not a canonical non-negative decimal integer filling the line.
fn amount_from_text(
    text: &SorobanString,
    prefix: &SorobanString,
    guards: &Vec<TextGuard>,
) -> Option<i128> {
    let text = Buf::<MAX_TEXT_LEN>::load(text)?;
    let prefix = Buf::<MAX_PREFIX_LEN>::load(prefix)?;
    if prefix.as_slice().is_empty() {
        return None;
    }
    let text = text.as_slice();
    if !guards.iter().all(|guard| guard_holds(text, &guard)) {
        return None;
    }
    parse_canonical_i128(unique_line_value(text, prefix.as_slice())?)
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
