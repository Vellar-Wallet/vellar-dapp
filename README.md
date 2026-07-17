# VELA Wallet

Web-first Stellar smart wallet with a companion browser extension: passkey onboarding, smart-account policies, contract verification & trust signals, and account cleanup/merge tooling.

- **Spec:** [technical-doc.md](technical-doc.md) (authoritative) + [idea.md](idea.md) (detailed interfaces/APIs)
- **Progress:** [BUILD-PLAN.md](BUILD-PLAN.md)
- **Contributor/agent rules:** [CLAUDE.md](CLAUDE.md)
- **Decisions:** [docs/decisions.md](docs/decisions.md)

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
   pnpm dev --filter=!@vela/extension  # web + gateway + services only
   ```

   Ports: web `:3000`, gateway `:4000`, wallet `:4001`, lifecycle `:4002`,
   policy `:4003`, Postgres `:5433`, Redis `:6380`.

3. **Verify:** `curl localhost:4000/health` and open `http://localhost:3000`.

Integration tests that hit a real database run against `vela_test` (seeded by
the compose init script) when `TEST_DATABASE_URL` is set; otherwise they skip:

```sh
TEST_DATABASE_URL="postgres://vela:vela@localhost:5433/vela_test" pnpm test
```
