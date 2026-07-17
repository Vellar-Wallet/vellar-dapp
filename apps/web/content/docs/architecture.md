# Architecture

VELA is a **pnpm + Turborepo monorepo**. TypeScript is used for all apps,
shared packages, and backend services; Rust/Soroban is used only for smart
contracts.

## Repository layout

```
apps/
  web/          Next.js web app — the primary surface
  extension/    Browser extension (WXT / Manifest V3) — connection + signing
  docs/         This documentation
packages/       Shared client + backend-bootstrap code (see below)
services/       Backend services (TypeScript / Fastify)
contracts/      Soroban smart contracts (Rust)
infra/          Local dev infrastructure (docker-compose: Postgres, Redis)
```

## Shared packages (`packages/`)

Web and extension share logic through these packages so wallet behavior is
never duplicated across surfaces.

| Package | Status | Responsibility |
| --- | --- | --- |
| `@vela/types` | implemented | Domain types shared end to end (wallet session, policy definition, network) |
| `@vela/wallet-sdk` | implemented | Wallet connector (PasskeyKit-backed), payment client, balances, tx-status, session store |
| `@vela/passkey` | implemented | WebAuthn support detection + error normalization |
| `@vela/provider-sdk` | implemented | dApp provider protocol (zod-validated), page provider, per-origin permissions |
| `@vela/service-kit` | implemented | Shared backend bootstrap — health route, startup/shutdown, safe DB connect |
| `@vela/policy-sdk` | stub | Policy client helpers (logic currently lives in the web app + policy-service) |
| `@vela/lifecycle-sdk` | stub | Lifecycle client helpers (logic currently in the web app + lifecycle-service) |
| `@vela/verification-sdk` | stub | Verification client helpers (awaits the verification service) |
| `@vela/ui` | stub | Shared UI primitives |

> The **stub** packages are intentional placeholders. Their functionality
> exists today inside the apps and services; extracting it into these shared
> packages is planned work, not missing behavior.

## Backend services (`services/`)

All services are Fastify apps in TypeScript, bootstrapped via `@vela/service-kit`.

| Service | Port | Status | Responsibility |
| --- | --- | --- | --- |
| `api-gateway` | 4000 | implemented | Single entrypoint; CORS; proxies to the owning service |
| `wallet-service` | 4001 | implemented | Wallet metadata, sessions/devices, submission, audit log |
| `lifecycle-service` | 4002 | implemented | Account inspection, cleanup planning, merge |
| `policy-service` | 4003 | implemented | Policy templates, validation, generate, simulate, deploy |
| `permission-service` | — | stub | Server-side origin permission records (extension-local is authoritative today) |
| `verification-service` | — | stub | Contract verification submission/status (planned) |
| `worker-service` | — | stub | Background jobs — deterministic build workers, indexer (planned) |

### The gateway

`api-gateway` is the only service a browser client talks to. It proxies by
prefix:

- `/wallet/*` → wallet-service
- `/lifecycle/*` → lifecycle-service
- `/policies/*` → policy-service

CORS is locked to the configured web-app origin. See
[API Reference](./api-reference.md) for every endpoint.

## Contracts (`contracts/`)

A Cargo workspace of Soroban (Rust) contracts.

- `policy-templates/spending-limit` — the configurable spending-limit policy
  contract (implemented, deployed to testnet). See
  [Policy Contract](./policy-contract.md).
- `smart-account` — reserved. VELA uses the audited **passkey-kit** smart-wallet
  contract for the account itself rather than a vendored copy.

## Persistence

Services use **drizzle-orm + node-postgres**. Migrations are applied
idempotently at startup. Each service that needs a database degrades to
in-memory repositories (behind the same interface) when `DATABASE_URL` is unset
or unreachable, so local development and tests work without a database.

- wallet-service: `wallets`, `wallet_sessions`, `activity_logs`
- policy-service: `policies`

## External dependencies

| Dependency | Used for |
| --- | --- |
| **Stellar RPC (Soroban)** | Contract simulation, submission, account state |
| **Horizon** | Classic-account inspection (cleanup/merge) |
| **OpenZeppelin Relayer** | Fee sponsorship — the wallet holds no XLM for fees |
| **passkey-kit** | Passkey smart-wallet SDK + the deployed smart-wallet contract |

### A note on submission

passkey-kit v0.14 signs address-bound V2 credentials (CAP-0071-02) that the
relayer's parser cannot yet handle. For those transactions, wallet-service
rebuilds the envelope around the signed auth entries and submits it directly to
RPC using a funded sponsor account; everything else goes through the relayer.
This "hybrid submitter" is transparent to the client.

## Data flow (a payment, end to end)

1. Web app builds the transfer (simulated during build) and shows a review.
2. User approves → the passkey signs the wallet's auth entries (WebAuthn).
3. Signed XDR is posted to `POST /wallet/submit` via the gateway.
4. wallet-service submits (relayer or sponsor path) and returns the tx hash.
5. The client polls RPC until the transaction reaches finality, then refetches
   balances.

No private key ever leaves the user's device; the backend never signs.
