# Staging tier and promotion runbook

Catalogue item 1.4. Before this there was local and production and nothing
between them. This defines a **testnet-only staging stack on Railway** and how a
commit moves from staging to production.

## Where production actually runs (evidence, 2026-11-02)

| Surface                                                                          | Host                    | Evidence                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend (`@vellar/all-in-one`: gateway, wallet, lifecycle, policy, verification) | **Railway**             | `vellar-backend-production.up.railway.app` answers `{"service":"api-gateway"}` from `railway-hikari`; `/verification/<id>` returns the x402 `stellar:pubnet` challenge; root `Dockerfile` + `railway.json`; process start 2026-09-29 03:25 UTC |
| Backend duplicate                                                                | **Render** (still live) | `vellar-backend.onrender.com/health` returns 200 after a free-tier cold start and serves the same `stellar:pubnet` challenge and payTo. Intent unknown; see `render.yaml` header                                                               |
| Facilitator                                                                      | Railway                 | `vellar-facilitator-production.up.railway.app/health`                                                                                                                                                                                          |
| Web, landing, docs, explorer, playground                                         | Vercel                  | `server: Vercel`; Vercel Production deployments on every merge to `main`                                                                                                                                                                       |
| `api.vellar.xyz`                                                                 | none                    | no DNS record resolves. The extension's default API (`apps/extension/lib/verification.ts`) points here                                                                                                                                         |

Two consequences worth knowing before you promote anything:

- **The live Railway process predates everything merged since 2026-09-29**
  (the dependency fixes, replay protection, the network-resolution fix). Merging to
  `main` does not deploy the backend; it is deployed by hand.
- `render.yaml` is stale and must not be used as a template for staging.

## What staging is

Same image, same Dockerfile, a separate Railway **environment** in the same
project. It differs from production only in its variables and its database:

- `DEPLOY_ENV=staging` plus testnet network, passphrase and RPC. The service
  refuses to boot otherwise (`enforceDeployEnvPolicy`, exit 1, every problem named).
- Its own Postgres service. Never the production database.
- Testnet-only keys, generated for staging. No production secret is reused.
- No automatic deploy on push, and `ALLOW_INMEMORY` / `ALLOW_SINGLE_KEY_ATTESTOR` unset.

The variable list is `infra/staging/staging.env.example`.

## Dashboard steps (what you need to click)

This repo creates nothing in Railway. Adding the staging Postgres (and a second
running service) may be billable on your plan; check before you click.

1. **Railway project -> Environments -> New environment**, name it `staging`.
   Choose "empty", not "duplicate", so production variables are not copied over.
2. In `staging`: **New -> GitHub repo -> `Vellar-Wallet/vellar-dapp`**. Builder
   Dockerfile (`railway.json` already says so). Same healthcheck path `/health`.
3. **Disable automatic deploys for BOTH environments**: remove the branch deploy
   trigger (or set it to require a manual deploy) in each service's source/deploy
   settings. Labels in the Railway UI change; the requirement is that a push to
   `main` deploys nothing by itself. Confirm by pushing a docs-only commit.
4. In `staging`: **New -> Database -> PostgreSQL**. This is the staging database.
5. In `staging` -> backend service -> **Variables -> Raw Editor**, paste
   `infra/staging/staging.env.example`, then add the three secrets
   (`RELAYER_API_KEY`, `SPONSOR_SECRET_KEY`, `SPONSOR_PUBLIC_KEY`) with
   **testnet-only** values. Fund the sponsor account from friendbot.
6. Confirm `DATABASE_URL` references the **staging** Postgres, and that no
   variable in `staging` references the `production` environment.
7. Deploy `staging` once. A misconfigured environment exits at boot with a
   message listing each violation; fix it and redeploy.
8. Give staging a domain (a Railway-generated one is fine) and point a staging
   web build at it (`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_STELLAR_NETWORK=testnet`).

## Promote a commit staging -> production

A commit is promoted by deploying **the same commit SHA** to both environments,
in that order. Never promote a build artifact from a different SHA.

1. Pick the SHA (a green commit on `main`; CI must have passed).
2. Deploy that SHA to `staging` (dashboard: Deployments -> Deploy a specific
   commit, or `railway up` from a checkout of that SHA with `--environment staging`).
3. Smoke gate on staging, all must pass:
   - `curl -fsS https://<staging-host>/health` returns `{"status":"ok",...}`.
   - `curl -s https://<staging-host>/verification/<testnet-contract-id>` returns
     402 and the challenge names `stellar:testnet`, **not** `stellar:pubnet`.
   - Create a testnet wallet, sign and submit once from the staging web build.
   - Submit the same signed transaction twice: the second must be `409 replay_detected`.
4. Record the SHA and the time in the release notes.
5. Deploy the **same SHA** to `production` the same way. Watch `/health` and the
   first real requests.
6. **Rollback** is a redeploy of the previous production deployment in Railway.
   Migrations are forward-only (`CREATE TABLE`), so a rollback does not undo schema.

## Known gaps

- There is no automated deploy gate script on `main`. A `deploy-health-gate` exists
  on the `dev` branch and is a candidate for promotion; until then the smoke gate
  above is manual.
- Railway builds each environment separately from the Dockerfile. Reproducibility
  rests on `pnpm-lock.yaml` being committed (it is) and the same SHA being used.
- The Render leftover (see the table) is outside this runbook. Suspend or delete it,
  and rotate any secret set there, so there is exactly one mainnet backend.
