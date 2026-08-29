# Verified-Only Policy Contract

Soroban policy contract enforcing that target contracts in authorization contexts must be registered and verified in the verification registry.

## Features

- Resolves target contract address from authorization context (`Context::Contract`).
- Enforces registry verification via cross-contract call (`is_verified`).
- Denies by default when target contract is unverified or cannot be determined.
- Configurable enforcement mode, fixed at construction time.

## Enforcement Modes

| Mode | Behaviour |
|---|---|
| `Strict` | Authorize only when the target is verified in the registry (`is_verified` returns true). |
| `TrustedPublishersOnly` | Authorize when the target is verified. In a full implementation, also verifies the entry was attested by a publisher in the trusted list. |

**`Warn` mode is not implemented on-chain.** A policy contract can only authorize or reject a transaction — it cannot express a warning. Warn behaviour belongs in the client layer (see B10).

## Constructor

```rust
__constructor(wallet: Address, registry: Address, mode: EnforcementMode, trusted_publishers: Vec<Address>)
```

- `wallet`: The smart-wallet address this policy is bound to.
- `registry`: Address of the verified-registry contract.
- `mode`: `Strict` or `TrustedPublishersOnly`. Immutable after construction.
- `trusted_publishers`: List of publisher addresses trusted in `TrustedPublishersOnly` mode. Ignored in `Strict` mode. Immutable after construction.

## Functions

| Function | Auth | Description |
|---|---|---|
| `install(wallet)` | wallet | Bind this policy instance to the wallet. |
| `policy__(source, contexts)` | source | Evaluate authorization contexts against the verified registry. |
| `config()` | none | Return the current configuration (read-only). |
