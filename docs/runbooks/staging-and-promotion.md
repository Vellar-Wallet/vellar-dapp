# Staging tier and promotion runbook

Catalogue item 1.4. Before this there was local and production and nothing
between them. This defines a **testnet-only staging stack on Railway** and how a
commit moves from staging to production.

## Where production actually runs (Railway CLI + live probes, 2026-11-02)

Railway project `vellar`, **one environment: `production`. There is no `staging`.**

| Service (Railway)                       | Source                                        | Last deploy          | Notes                                                                                                               |
| --------------------------------------- | --------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `vellar-backend` (`@vellar/all-in-one`) | **no connected repo: deployed by CLI upload** | 2026-09-29 03:24 UTC | start `pnpm --filter @vellar/all-in-one start`; domain `vellar-backend-production.up.railway.app`; no custom domain |
| `vellar-facilitator`                    | `Vellar-Wallet/vellar-facilitator`            | 2026-09-29           | separate repo                                                                                                       |
| `vellar-explorer`                       | `Vellar-Wallet/vellar-explorer`               | 2026-09-29           | separate repo                                                                                                       |
| `vellar-seller-demo-testnet`            | `Vellar-Wallet/vellar-facilitator`            | 2026-10-07           | separate repo                                                                                                       |
| `vellar-admin-console`                  | (not inspected)                               |                      |                                                                                                                     |

Other facts the CLI and probes established:

- `vellar-backend` is configured for **mainnet** (`STELLAR_NETWORK`, passphrase, RPC and
  Horizon all mainnet; relayer on the bare OpenZeppelin host). It has `DATABASE_URL`,
  `SPONSOR_SECRET_KEY` and `RELAYER_API_KEY` set. It has **no** `ATTESTOR_SECRET_KEY`,
  no `DEPLOY_ENV`, no `ALLOW_INMEMORY`, no `ALLOW_SINGLE_KEY_ATTESTOR`.
- **No worker-service runs in this project.** The build worker, and with it the attestor, is
  not deployed here.
- Because the backend has no connected repo, **a push to `main` cannot deploy it**. It only
  changes when someone runs `railway up`. The live process therefore predates everything
  merged since 2026-09-29 (dependency fixes, replay protection, the network-resolution fix).
- Web, landing, docs, explorer and playground are on Vercel (`server: Vercel`, a Production
  deployment on every merge to `main`).
- `api.vellar.xyz` has no DNS record and is not mapped to any Railway service, yet the
  extension's default API (`apps/extension/lib/verification.ts`) points at it.
- **Render:** production on Railway is confirmed by the owner, but `vellar-backend.onrender.com`
  is still live: it returns 200 after a free-tier cold start and serves the same
  `stellar:pubnet` challenge and payTo. It is a leftover to shut down; see the `render.yaml` header.

## What staging is

Same code, same start command, a separate Railway **environment** in the same project. It
differs from production only in its variables and its database:

- `DEPLOY_ENV=staging` plus testnet network, passphrase and RPC. The service refuses to
  boot otherwise (`enforceDeployEnvPolicy`, exit 1, every problem named).
- Its own Postgres service. Never the production database.
- Testnet-only keys, generated for staging. No production secret is reused.
- No GitHub repo connected to either backend service (matching production today), and
  `ALLOW_INMEMORY` / `ALLOW_SINGLE_KEY_ATTESTOR` unset.

The variable list is `infra/staging/staging.env.example`.

## Dashboard steps (what you need to click)

This repo creates nothing in Railway. Adding the staging Postgres and a second running
service may be billable on your plan; check before you click.

1. **Project `vellar` -> Environments -> New environment**, name it `staging`, and choose an
   **empty** environment so production variables are not copied over. (CLI:
   `railway environment new staging`; confirm with `railway environment list`.)
2. In `staging`: **New -> Empty service**, name it `vellar-backend`. Do **not** connect a
   GitHub repo. In its settings, set the start command to
   `pnpm --filter @vellar/all-in-one start`, as production has it.
3. In `staging`: **New -> Database -> PostgreSQL**. This is the staging database.
4. In `staging` -> `vellar-backend` -> **Variables -> Raw Editor**, paste
   `infra/staging/staging.env.example`, then add the three secrets (`RELAYER_API_KEY`,
   `SPONSOR_SECRET_KEY`, `SPONSOR_PUBLIC_KEY`) with **testnet-only** values. Fund the sponsor
   account from friendbot.
5. Confirm `DATABASE_URL` references the **staging** Postgres and that no variable in
   `staging` references the `production` environment.
6. Deploy once (next section). A misconfigured environment exits at boot with a message
   listing each violation; fix it and redeploy.
7. Give staging a domain (a Railway-generated one is fine) and point a staging web build at
   it (`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_STELLAR_NETWORK=testnet`).

## Promote a commit staging -> production

Production is deployed by upload, so a promotion is: check out a SHA, upload that exact
tree to staging, verify, then upload the **same tree** to production.

1. Pick the SHA (a green commit on `main`) and check it out clean (`git status` empty;
   `railway up` uploads the working tree, including anything uncommitted).
2. `railway up --environment staging --service vellar-backend --ci`
3. Smoke gate on staging, all must pass:
   - `curl -fsS https://<staging-host>/health` returns `{"status":"ok",...}`.
   - `curl -s https://<staging-host>/verification/<testnet-contract-id>` returns 402 and the
     challenge names `stellar:testnet`, **not** `stellar:pubnet`.
   - Create a testnet wallet, sign and submit once from the staging web build.
   - Submit the same signed transaction twice: the second must be `409 replay_detected`.
4. Record the SHA and the time in the release notes.
5. From the **same clean checkout**:
   `railway up --environment production --service vellar-backend --ci`. Watch `/health`
   and the first real requests.
6. **Rollback** is a redeploy of the previous production deployment in Railway.
   Migrations are forward-only (`CREATE TABLE`), so a rollback does not undo schema.

## Known gaps

- There is no automated deploy gate script on `main`. A `deploy-health-gate` exists
  on the `dev` branch and is a candidate for promotion; until then the smoke gate
  above is manual.
- Deploys are uploads of a working tree, not builds of a commit, so nothing records which
  SHA is live (the production deployment has no commit hash). Tag the SHA in git when you
  promote it.
- The Render leftover (see the bullets above) is outside this runbook. Suspend or delete it,
  and rotate any secret set there, so there is exactly one mainnet backend.
