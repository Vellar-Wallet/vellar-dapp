# Overview

VELA is a **web-first Stellar smart wallet** with a companion **browser
extension**. It combines passkey onboarding, programmable account policies
(smart accounts), contract verification / trust signals, account cleanup &
merge tooling, and extension-based dApp connection + signing.

The wallet is non-custodial: VELA never holds, imports, or exports private
keys. Authentication is a **passkey** (WebAuthn), and each wallet is a
**smart-contract account** on Stellar (a Soroban smart wallet), not a classic
key-pair account.

## Capabilities (implemented today)

| Capability                      | Surface        | Summary                                                                                            |
| ------------------------------- | -------------- | -------------------------------------------------------------------------------------------------- |
| **Passkey onboarding**          | Web            | Create / reconnect a wallet with Face ID, Touch ID, or a security key. No seed phrase.             |
| **Smart account**               | Web            | Each wallet is a passkey-controlled Soroban smart-wallet contract (a C-address).                   |
| **Send & track payments**       | Web            | Build → review → passkey-sign → submit → track to finality, with fees sponsored.                   |
| **Account policies**            | Web            | Author policies from templates (spending limit, multisig, allowlist), review, and deploy on-chain. |
| **Configurable spending limit** | Web + contract | Deploy a per-account Soroban policy that enforces a user-chosen rolling-window spend cap.          |
| **Account cleanup & merge**     | Web            | A guided planner that inspects a classic account, plans cleanup, and merges it — never one-click.  |
| **dApp connection & signing**   | Extension      | Pair the extension as a device signer; approve dApp connections and transactions per-origin.       |
| **Trust signals in signing**    | Extension      | The signing prompt decodes the transaction and flags value transfers subject to account policies.  |

## The two surfaces

VELA deliberately splits work across two surfaces rather than shipping full
feature parity:

- **Web app** (`apps/web`, Next.js) — the primary surface. Onboarding,
  dashboard, payments, the policy builder, the cleanup wizard, and settings /
  device management.
- **Browser extension** (`apps/extension`, WXT / Manifest V3) — connection and
  signing. It pairs with a web-app wallet and holds a **device signer** (a
  non-extractable key) so it can approve dApp transactions without a passkey
  prompt on every action, while every action still requires explicit approval.

## How the pieces fit

```
┌─────────────┐        ┌──────────────┐
│  apps/web    │        │ apps/extension│
│  (Next.js)   │        │  (MV3)        │
└──────┬───────┘        └──────┬────────┘
       │  shared client logic  │
       │   (packages/*)        │
       ▼                       ▼
┌───────────────────────────────────────┐
│         api-gateway  (:4000)           │  ← single entrypoint, proxies:
└───┬──────────────┬──────────────┬──────┘
    ▼              ▼              ▼
 wallet-svc    lifecycle-svc  policy-svc     ← TypeScript / Fastify services
  (:4001)        (:4002)       (:4003)
    │              │              │
    └──────── Postgres ──────────┘           ← persistence (drizzle + pg)
                    │
             Stellar testnet                 ← RPC, Horizon, OZ Relayer
```

Web and extension share client logic through `packages/*` (wallet SDK, passkey
helpers, provider SDK, domain types), so wallet behavior is never duplicated
across surfaces. Backend services sit behind a single **API gateway** and own
their slice of functionality. Soroban contracts (Rust) live in `contracts/`.

See [Architecture](./architecture.md) for the full breakdown.
