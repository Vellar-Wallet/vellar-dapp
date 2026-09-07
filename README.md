# Vellar Wallet

<img width="5410" height="2088" alt="Full Logo White" src="https://github.com/user-attachments/assets/2eb47ce8-095d-4ce2-b64f-af530b7ce0f9" />


**Vellar** is a web-first Stellar smart wallet with a companion browser extension.
Passkey onboarding (no seed phrases), programmable on-chain account policies,
contract verification & trust signals, and account cleanup/merge tooling — plus
agentic payments via [x402](https://x402.org), so an autonomous agent can spend
under an on-chain budget without ever holding your keys.

The SDK that powers Vellar is published separately as
[`vellar-sdk`](https://github.com/Vellar-Wallet/vellar-sdk), with full docs at
**[docs.vellar.xyz](https://docs.vellar.xyz)**.

## Layout

Monorepo (pnpm + Turborepo): `apps/` (web, extension, docs) · `packages/` (shared SDKs/UI/types) · `services/` (backend) · `contracts/` (Soroban) · `infra/`.

## Getting started

```sh
pnpm install
pnpm typecheck
```

## Running locally

1. **Start the database** (Postgres + Redis) — the backend services load their
   config from a root `.env` and connect to Postgres on boot:

   ```sh
   cp .env.example .env        # then fill in RELAYER_* and SPONSOR_SECRET_KEY
   docker compose -f infra/docker/docker-compose.yml up -d
   ```

   The services read `.env` automatically (via `tsx --env-file-if-exists`). If
   Postgres is unreachable they fall back to **in-memory storage** with a
   warning (data won't survive a restart) rather than crashing — but for a real
   run you want the database up.

2. **Run the stack** (web + gateway + services). The extension's `dev` task
   launches a browser and needs Chrome installed; exclude it if you don't have
   Chrome or only want the backend:

   ```sh
   pnpm dev                          # everything, incl. the extension (needs Chrome)
   pnpm dev --filter=!@vellar/extension  # web + gateway + services only
   ```

   Ports: web `:3000`, gateway `:4000`, wallet `:4001`, lifecycle `:4002`,
   policy `:4003`, Postgres `:5433`, Redis `:6380`.

3. **Verify:** `curl localhost:4000/health` and open `http://localhost:3000`.

Integration tests that hit a real database run against a local test DB (seeded
by the compose init script) when `TEST_DATABASE_URL` is set; otherwise they
skip. See `.env.example` for the expected connection string shape.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0 — see [LICENSE](LICENSE).
