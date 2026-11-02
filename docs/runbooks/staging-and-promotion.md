# Railway services, staging tier and promotion runbook

Catalogue item 1.4. Everything deploys on **Railway**; Render is retired and `render.yaml` was
removed. This runbook records what exists, what the owner must check in the Railway dashboard
(several settings cannot be expressed in a committed file or read through the CLI), and how a
commit moves from a **staging** environment to production.

## Railway services (project `vellar`, environment `production`)

Facts below come from the Railway CLI, read-only, on 2026-11-02. Variable **names** are listed;
no value was read into this document. "Secret-like" means the name looks like a secret, token,
key or connection string; it is a name match, not a claim about the value.

| Service                                                                             | Source repo and branch                                               | Deploy trigger (evidence)                       | Public domain                                                 | Secret-like variable names                                                                                     |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `vellar-backend` (the all-in-one: gateway, wallet, lifecycle, policy, verification) | **none** (deployed by `railway up`, 2026-09-29)                      | no repo connected, so a push does not deploy it | yes, `vellar-backend-production.up.railway.app` (the gateway) | `DATABASE_URL`, `RELAYER_API_KEY`, `SPONSOR_SECRET_KEY`                                                        |
| `vellar-facilitator`                                                                | `Vellar-Wallet/vellar-facilitator`, `main` (`f903be3`, 2026-09-29)   | repo connected to `main`                        | yes                                                           | `ADMIN_SECRET`, `CATALOG_DB_AUTH_TOKEN`, `CHANNEL_ACCOUNT_SECRET_KEYS`, `SPONSOR_SECRET_KEY`, `VOYAGE_API_KEY` |
| `vellar-facilitator-testnet`                                                        | `Vellar-Wallet/vellar-facilitator`, `main` (`f13f310`, 2026-10-07)   | repo connected to `main`                        | yes                                                           | `ADMIN_SECRET`, `CATALOG_DB_AUTH_TOKEN`, `CHANNEL_ACCOUNT_SECRET_KEYS`, `SPONSOR_SECRET_KEY`                   |
| `vellar-seller-demo`                                                                | `Vellar-Wallet/vellar-facilitator`, `main` (`f903be3`, 2026-09-28)   | repo connected to `main`                        | yes                                                           | none                                                                                                           |
| `vellar-seller-demo-testnet`                                                        | `Vellar-Wallet/vellar-facilitator`, `main` (`f13f310`, 2026-10-07)   | repo connected to `main`                        | yes                                                           | none                                                                                                           |
| `vellar-explorer`                                                                   | `Vellar-Wallet/vellar-explorer`, `main` (`3c4aacc`, 2026-09-29)      | repo connected to `main`                        | yes                                                           | `EXPLORER_DB_AUTH_TOKEN`                                                                                       |
| `vellar-admin-console`                                                              | `Vellar-Wallet/vellar-admin-console`, `main` (`3125328`, 2026-09-29) | repo connected to `main`                        | yes                                                           | `ADMIN_PASSWORD`, `MAINNET_ADMIN_TOKEN`, `SESSION_SECRET`, `TESTNET_ADMIN_TOKEN`                               |

What is **not** in the project: a worker-service, any attestor or signer service, a Railway-hosted
Postgres (so `vellar-backend`'s `DATABASE_URL` points at an external database; I did not inspect
its host), and any `staging` environment. The web app, docs, explorer site and playground are on
Vercel, not Railway.

**Railway auto-deploys a connected repo on push by default.** "Repo connected to `main`" above
therefore means a merge to `main` of that repo is expected to deploy to production unless the
dashboard says otherwise. Only `vellar-backend` is known not to deploy on push, and only because
no repo is connected to it.

Other facts: `vellar-backend` is configured for mainnet; it has no `DEPLOY_ENV`, no attestor
variables and no `ALLOW_*` flags. `SPONSOR_SECRET_KEY` appears on three services
(`vellar-backend`, `vellar-facilitator`, `vellar-facilitator-testnet`); confirm in each that it is a
**different account** and that no testnet service holds a mainnet key.

## What to check per service (V6, L2, M9)

Target: **only the gateway has a public domain.** Internal services use Railway's private network
(`<service>.railway.internal`) and have no public domain and no TCP proxy. The CLI status does
not show private networking or TCP proxies, so these are dashboard checks.

For **every** service, in its Settings and Networking pages:

1. **Public domain.** Is one generated or custom? Does it need to be public? Each row above says
   what is public today; the CLI shows all seven are.
2. **TCP proxy.** There should be none.
3. **Private networking.** Enabled, and the service reachable internally by its `.railway.internal` name.
4. **Deploy trigger.** Is a repo connected, to which branch, and does a push deploy? For the
   services marked "repo connected to `main`", decide whether a merge should auto-deploy to
   production. If not, disconnect the trigger or enable the "wait for CI" gate if your plan offers it.
5. **Variables.** The secret-like names above should be marked sealed or otherwise hidden where
   Railway supports it, and none should be shared between a testnet and a mainnet service.

Service-specific:

- `vellar-backend`: confirm there is **exactly one** public domain (the gateway) and no custom
  domain pointing somewhere unintended. The wallet, lifecycle, policy and verification services
  share its container and bind to loopback, so nothing else is reachable. Confirm no `HOST` variable
  sets a wildcard bind.
- `vellar-admin-console`: it holds `MAINNET_ADMIN_TOKEN` and has a public domain. Confirm it
  requires authentication on every route, and consider restricting it by IP or an access proxy.
- `vellar-facilitator` and `vellar-facilitator-testnet`: confirm the admin surface (`ADMIN_SECRET`)
  is not reachable without that secret on the public domain.
- `vellar-explorer`: read-only by design; confirm it holds no write-capable token beyond the
  database token it needs.
- Seller demos: public by design; confirm they hold no secret.

## What staging is

A Railway **environment** named `staging` in the same project, with the same start command and the
same code, differing from production only in its variables and its database:

- its **own Postgres** service inside the `staging` environment (production has none to share);
- `DEPLOY_ENV=staging`, which makes the service **refuse to boot** (exit 1, naming each problem)
  unless it is pinned to testnet, has its own `DATABASE_URL`, has `ALLOW_INMEMORY` and
  `ALLOW_SINGLE_KEY_ATTESTOR` unset, and allows no production CORS origin
  (`packages/service-kit/src/deploy-env.ts`);
- a **database tier marker**: each database holds a one-row `deployment_marker` table. A staging
  process refuses to boot unless its database says `staging`; a production process refuses a
  database that says `staging`. No production connection string is ever placed in staging.
  Production adopts its (unmarked) database as `production` on its first boot after this change
  (one new table and one row). Staging never adopts silently: set `INIT_DEPLOY_MARKER=1` for ONE
  boot against the new, EMPTY staging database, then unset it (an existing, non-empty database is
  refused);
- testnet-only keys generated for staging, with no production secret reused;
- it deploys from a **`staging` branch**, and **nothing deploys production automatically**.

The variable list is `infra/staging/staging.env.example`.

## Dashboard-only settings the owner must set

None of these can be set from a committed file, and the CLI cannot confirm them. This repo creates
nothing in Railway; the staging Postgres and a second running service may be billable.

1. **Create the environment.** Project `vellar` -> Environments -> New environment `staging`,
   **empty** (not a copy of production, which would copy its mainnet variables). CLI:
   `railway environment new staging`, then `railway environment list`.
2. **Create the staging service.** In `staging`, add an empty service `vellar-backend`. Set its
   start command to `pnpm --filter @vellar/all-in-one start`, the same as production.
3. **Connect it to the `staging` branch only.** Source -> connect `Vellar-Wallet/vellar-dapp`, branch
   **`staging`**. Auto-deploy on that branch is intended: it is staging. Turn on the "wait for CI"
   option if available.
4. **Leave production unconnected.** Keep the production `vellar-backend` with **no repo
   connected**, as today, so no push can deploy it. If it is ever connected, disable its deploy
   trigger or require CI first. This is the M9 control; M9 stays reopened until you confirm it.
5. **Add the staging Postgres.** In `staging`: New -> Database -> PostgreSQL. Point `DATABASE_URL`
   at that service's variable; no variable in `staging` may reference the `production` environment.
   Set `INIT_DEPLOY_MARKER=1` for the first boot only, so the services claim the empty database as
   staging, then remove it.
6. **Paste the variables.** Raw Editor, from `infra/staging/staging.env.example`, then add the three
   secrets (`RELAYER_API_KEY`, `SPONSOR_SECRET_KEY`, `SPONSOR_PUBLIC_KEY`) with **testnet-only**
   values, the sponsor funded from friendbot.
7. **Networking.** Staging gets at most one public domain (the gateway); no TCP proxy.
8. **PR environments off.** A Railway PR environment copies variables from an existing environment
   and runs PR code with them. Confirm the feature is off, or scoped so it can never copy
   `production`. (`railway environment list` showed only `production` today.)
9. **GitHub, not Railway.** Branch protection on `main` and on `staging`: require a PR and the
   `ci` check, no direct pushes, and restrict who can push `staging`.

## Promote a commit staging -> production

The same commit goes to staging, is verified there, then goes to production.

1. Choose a green commit on `main`. Fast-forward the `staging` branch to it:
   `git push dapp <sha>:staging` (a fast-forward only; never force). The staging service deploys.
2. Smoke gate on staging, all must pass:
   - `GET /health` returns `{"status":"ok",...}`.
   - `GET /verification/<testnet-contract-id>` returns 402 and the challenge names
     `stellar:testnet`, **not** `stellar:pubnet`.
   - Create a testnet wallet, sign and submit once from a staging web build.
   - Submit the same signed transaction twice: the second must be `409 replay_detected`.
3. Tag the commit in git (for example `prod-2026-11-02`), because a Railway upload does not record
   which commit is live (the production deployment has no commit hash).
4. Deploy **the same commit** to production, by hand: from a clean checkout of the tag,
   `railway up --environment production --service vellar-backend --ci`. Watch `/health` and the
   first real requests.
5. **Rollback** is a redeploy of the previous production deployment in Railway. Migrations are
   forward-only (`CREATE TABLE`), so a rollback does not undo schema.

## Known gaps

- There is no automated deploy gate script on `main`. A `deploy-health-gate` exists on the `dev`
  branch and is a candidate for promotion; until then the smoke gate above is manual.
- Production `vellar-backend` is a manual upload, so nothing in git records what is live. The tag in
  step 3 is the only record.
- Render is retired, but `vellar-backend.onrender.com` still answered on mainnet when last probed
  (2026-11-02). Shutting it down and rotating the secrets it held is the owner's task; the code still
  reads a Render-injected `RENDER_EXTERNAL_URL` as a fallback, harmless on Railway where
  `PUBLIC_BASE_URL` is set.
