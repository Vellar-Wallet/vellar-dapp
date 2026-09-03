# @vellar/verification-service

Verification submissions, source bundle metadata, artifact comparison, status APIs

## Staging environment (#338)

Staging is a dedicated deployment target with its own port, database, and
service URL — never run against dev's or production's config directly.

### Setup

1. Copy the template to your staging host/process manager:
   ```sh
   cp services/verification-service/.env.staging.example services/verification-service/.env.staging
   ```
2. Provision a **separate** staging Postgres instance and set `DATABASE_URL`
   in `.env.staging` to point at it (commented out by default so the service
   falls back to its in-memory repository — loud warning, no crash — until
   you provision one; see `tryConnectDb` in `@vellar/service-kit`).
3. Leave `STELLAR_RPC_URL`/`STELLAR_NETWORK_PASSPHRASE` at their defaults
   (Stellar's public TESTNET RPC) — this is the "third-party lookup" target
   staging verifies contract WASM hashes against. **Never** point staging at
   the PUBLIC/mainnet passphrase; `configFromEnv`'s test coverage
   (`src/config.staging.test.ts`) asserts this explicitly.
4. Start the service with the staging env file:
   ```sh
   tsx --env-file=services/verification-service/.env.staging services/verification-service/src/index.ts
   ```
5. Verify it started correctly:
   ```sh
   curl http://localhost:$VERIFICATION_SERVICE_PORT/health
   # => {"status":"ok","service":"verification-service"}
   ```
   (`src/config.staging.test.ts` covers the same check — resolving the
   staging env and booting a real server against it — as an automated test,
   so a config regression fails CI instead of only being caught manually.)

### What's covered vs. out of scope

This env file and its test cover configuration correctness: staging points
at the right (test-only) RPC endpoint, an isolated database, and distinct
ports so it doesn't collide with local dev. It does **not** provision actual
staging infrastructure (a running staging Postgres, a staging host/container)
— those are deployment-time concerns tracked separately once the project
adopts an orchestrator (see `infra/README.md`'s `k8s/` note); today the
project runs as a single combined process on Railway/Render (`railway.json`,
`render.yaml`), which don't yet distinguish a staging tier from production.
