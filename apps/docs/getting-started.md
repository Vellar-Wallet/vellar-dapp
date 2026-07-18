# Getting Started

## Prerequisites

| Tool                     | Version                  | Used for                                                 |
| ------------------------ | ------------------------ | -------------------------------------------------------- |
| **Node.js**              | ≥ 20.6                   | Runtime (needs `--env-file` support)                     |
| **pnpm**                 | 11.x                     | Workspace / package manager                              |
| **Docker**               | any recent               | Local Postgres + Redis                                   |
| **Rust + `stellar` CLI** | cargo 1.94+, stellar 26+ | Only for building/deploying the Soroban policy contract  |
| **Chrome**               | any recent               | Only for the extension's `dev` task (launches a browser) |

## Install

```sh
pnpm install
pnpm typecheck   # sanity check the whole workspace
```

## Configure

Backend services read configuration from a root `.env` (loaded automatically
via `tsx --env-file-if-exists`).

```sh
cp .env.example .env
```

Then fill in the values you have. The important ones:

| Variable                              | Needed for                               | Notes                                                                     |
| ------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| `DATABASE_URL`                        | Persistence                              | `postgres://vela:vela@localhost:5433/vela` for local Docker               |
| `RELAYER_BASE_URL`, `RELAYER_API_KEY` | Fee sponsorship                          | OpenZeppelin Relayer; without them, wallet creation/submission return 502 |
| `SPONSOR_SECRET_KEY`                  | Address-auth submission + policy deploys | A funded testnet account secret                                           |

The web app needs no env for local testnet use — it defaults to Stellar
testnet (RPC, Horizon, passphrase, and the smart-wallet wasm hash are all
built-in). Override with `NEXT_PUBLIC_*` variables for mainnet or custom RPC.

## Run the stack

**1. Start the database** (Postgres on `:5433`, Redis on `:6380`):

```sh
docker compose -f infra/docker/docker-compose.yml up -d
```

If Postgres is unreachable, the services fall back to **in-memory storage**
with a warning (data won't survive a restart) rather than crashing — fine for a
quick look, but start the database for a real run.

**2. Start the app.** The extension's `dev` task launches Chrome; exclude it if
you don't need the extension or don't have Chrome:

```sh
pnpm dev                             # everything (extension needs Chrome)
pnpm dev --filter=!@vela/extension   # web + gateway + services only
```

## Ports

| Service           | Port   |
| ----------------- | ------ |
| Web app           | `3000` |
| API gateway       | `4000` |
| wallet-service    | `4001` |
| lifecycle-service | `4002` |
| policy-service    | `4003` |
| Postgres          | `5433` |
| Redis             | `6380` |

## Verify

```sh
curl localhost:4000/health          # {"status":"ok","service":"api-gateway"}
open http://localhost:3000          # marketing landing; /app to onboard
```

> **Passkeys need a real browser.** Create/sign flows use WebAuthn, which does
> not work in embedded/preview browsers (e.g. the VS Code simple browser). Use
> Chrome or Safari.

## Testing

```sh
pnpm test         # unit + integration across all workspaces
pnpm typecheck    # TypeScript across all workspaces
```

Integration tests that hit a real database run against the `vela_test` database
(seeded by the compose init script) when `TEST_DATABASE_URL` is set; otherwise
they skip:

```sh
TEST_DATABASE_URL="postgres://vela:vela@localhost:5433/vela_test" pnpm test
```

End-to-end (Playwright, against live testnet with a virtual WebAuthn
authenticator) requires the gateway + services running:

```sh
pnpm exec playwright install chromium   # once
pnpm --filter @vela/web test:e2e
```

## Soroban contract (optional)

The configurable spending-limit policy contract lives in
`contracts/policy-templates/spending-limit`. To build and test it:

```sh
cd contracts
cargo test -p vela-spending-limit-policy   # unit tests
stellar contract build                     # optimized wasm
```

See [Policy Contract](./policy-contract.md) for deployment.
