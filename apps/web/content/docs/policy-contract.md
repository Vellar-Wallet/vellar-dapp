# Policy Contract — Configurable Spending Limit

Source: `contracts/policy-templates/spending-limit` (crate
`vela-spending-limit-policy`).
Testnet wasm hash: `5d52e44c3794a185aaa4a42478b6b59bf9a976ee0d95b08aab8a855d156e9ff1`.

This is a hardened, **configurable** derivative of the audited passkey-kit
`sample-policy`. It lets a user choose their own spending limit in the UI and
have *that number* enforced on-chain, per account.

## Why a cumulative window, not a per-transaction cap

A policy signer carries **no secret** — anyone can submit it, so a policy that
authorizes value transfers authorizes them for everyone. That means a
per-transaction cap is **not** a spending limit: repeated capped transfers can
drain the whole balance.

So the user's limit is enforced as a **cumulative allowance over a rolling
window**: the most anyone can move through the policy is `daily_limit` per
`window_seconds`. Worst-case loss is bounded to the cap. For a hard guarantee
that even that bounded amount requires a real signature, the policy can be
paired — via the granting signer's `SignerLimits` — with an authenticated
co-signer.

## Constructor (immutable configuration)

```rust
pub fn __constructor(env: Env, wallet: Address, daily_limit: i128, window_seconds: u64)
```

- `wallet` — the single smart account this instance is bound to.
- `daily_limit` — cumulative window allowance, in **stroops** (1 XLM =
  10,000,000 stroops).
- `window_seconds` — rolling-window length (VELA uses 24h = 86400 by default).

Configuration is written **once** and never mutated — there is no setter. If the
owner could raise their own cap in-place, the policy would guarantee nothing.
Changing a limit means deploying a fresh instance and re-attaching it with a
passkey (an explicit, auditable admin action).

Range checks: `daily_limit ≥ 1`, `1 ≤ window_seconds ≤ 31,536,000` (365 days).

## Single-tenant binding

Each instance is bound to one wallet at deploy. Both the `install` hook and the
`policy__` authorization check reject any wallet other than the bound one, so a
deployed instance cannot be attached to — or spent through — a different account.

## Preserved security invariants

The contract keeps every hardening property of the reference policy:

- **Caller authentication** — `source.require_auth()` before touching any
  per-wallet state.
- **Deny-by-default** — only positive `transfer`s to a non-wallet contract pass;
  any other function, a non-contract context, a missing/mistyped amount, a
  non-positive amount, or a context targeting the wallet's own admin surface all
  fail closed.
- **Checked arithmetic** throughout.
- **TTL renewal** on install and every successful check, so the policy can't
  silently archive into a wallet lock.
- **Permissionless self-clean** — `uninstall` clears per-wallet state only after
  confirming the policy is genuinely no longer a signer on that wallet.

## Deploy flow

The contract is instantiated per user (see
[Core Flows §4](./core-flows.md#4-create-and-deploy-a-policy)):

1. policy-service deploys a configured instance bound to the account
   (sponsor-funded, from the wasm hash above).
2. The web app passkey-signs `kit.addPolicy(contractId, …)` to attach it, which
   runs the contract's `install` hook.

### Build & test locally

```sh
cd contracts
cargo test -p vela-spending-limit-policy   # unit tests (constructor validation,
                                           # deny-by-default, window enforcement,
                                           # wrong-wallet, TTL, self-clean)
stellar contract build                     # optimized wasm
```

## Status

**Testnet only. Not yet audited for mainnet.** Mainnet use is gated on the
smart-contract security-review checklist (see [Security Model](./security-model.md)).
Dependencies are pinned to the audited passkey-kit contract workspace
(soroban-sdk 27, `smart-wallet-interface` via a pinned commit).
