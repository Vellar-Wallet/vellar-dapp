# CI baseline and the `dev` push gate (#427, #429)

Decision record. `docs/decisions.md` is not tracked in this repository, so the
entry lives here; copy it across if you keep the private log.

## Decision (2026-09-25): fix, then gate

`ci.yml` now runs on pushes to `dev` as well as `main`. It was added **together
with** the fixes below rather than on top of a known-failure list: the red suite
was small enough to fix at the root, and a gate that is red on day one teaches
everyone to ignore it. No test was skipped, deleted or loosened to get here.

## What "red" actually was

Upstream CI had not run the test suite since 2026-09-17. Every run that started a
job failed at the first gate, **Audit dependencies**, so format, typecheck, tests
and build never executed. Many PR runs since 2026-09-24 started **zero jobs**
("likely failed because of a workflow file issue") — `actionlint` passes on
`ci.yml`, identical files produced both outcomes on the same day, so this is on the
GitHub side (Actions settings or billing) and needs a maintainer to check.

Measured locally on `dev` at `484e7b5`, then fixed in this branch:

| Area                                                           | Was                                        | Root cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Fix                                                                                                                                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audit (first CI step)                                          | 2 critical, 3 high                         | `next` < 16.3.3; `sharp`, `smol-toml`, `adm-zip` transitive advisories                                                                                                                                                                                                                                                                                                                                                                                                                     | `next` ^16.3.3; same-major overrides in `pnpm-workspace.yaml`                                                                                                                                                    |
| Load-test step                                                 | always failing                             | `44d8ce1` deleted the harness and root `test:load` script but left the step                                                                                                                                                                                                                                                                                                                                                                                                                | step removed; re-add with the harness (docs/LOAD_TESTING.md)                                                                                                                                                     |
| policy-service                                                 | 172/172 tests pass on `dev`; typecheck red | #429's 30 failures were already fixed on `dev` by `942b839` (server.ts referenced schemas/helpers it never imported — every deploy route threw `ReferenceError`). Remaining: test fixture types, a duplicate import, and **`processDeploymentJob` passing `policy.constructorArgs` (always `undefined`) to the deployer**                                                                                                                                                                  | fixtures typed; DLQ `insert` input type matches what the store owns; worker reads `manifest.enforcement.constructorArgs` and refuses non-contract policies (new tests)                                           |
| worker-service                                                 | 31 failing, typecheck red                  | **M7 reaper SQL** `to_jsonb('submitted')` is untyped and Postgres rejects it, so every reclaim/dead-letter failed; reaper metrics `verificationRetry`/`verificationDeadLetter` were never defined (TypeError before the reclaim); cleanup config fields lost in a merge made `setInterval(…, undefined)` spin every 1 ms; secrets redactor missed real Stellar seeds (wrong length, `SA` only) and `sk_live_/sk_test_` keys; `BACKOFF_CONFIG` not frozen; two DB suites raced on one table | literals cast `::text`; counters added to service-kit; config restored from the #345 commit; redactor patterns fixed; config frozen; per-file Postgres schema; test timing/model fixes that keep every assertion |
| wallet-service                                                 | 8 failing, typecheck red                   | **`cache-metrics.ts` imported `prom-client`, which wallet-service does not depend on — `@vellar/all-in-one` (the Render backend) crashed at import**; `z.record(z.unknown())` is zod-3 syntax; metrics test built a server without the production cache wiring; cache TTL test waited less than the TTL                                                                                                                                                                                    | `Counter` from `@vellar/service-kit`; zod 4 `z.record(key, value)`; test wires the cache like `index.ts`; wait past TTL                                                                                          |
| lifecycle-service                                              | 1 failing, typecheck red                   | test read `account.id` (contract says `HorizonAccount.accountId`), used addresses with invalid checksums (which the shape-only validator let through to a 500), and asserted on a `step.operations` field `CleanupStep` never had                                                                                                                                                                                                                                                          | `isClassicAccountId` checks the StrKey checksum (400 instead of 500); test decodes the step XDR to assert the `accountMerge`                                                                                     |
| provider-sdk (+ extension, permission-service, web via import) | typecheck red                              | unnarrowed union in `sep43.ts` `requestAccess`                                                                                                                                                                                                                                                                                                                                                                                                                                             | narrow with `"network" in result`                                                                                                                                                                                |
| web                                                            | typecheck red; 1 timeout under load        | index access without guards; a cold `import("passkey-kit")` inside the tested function                                                                                                                                                                                                                                                                                                                                                                                                     | non-null assertions in tests; module pre-warmed in `beforeAll`                                                                                                                                                   |
| web e2e (mocked, `@ci`)                                        | 5 of 14 failing after the `next` bump      | Next 16.3 renders its route announcer (`role="alert"`) on load, so the strict `getByRole("alert")` in `receive-pay.spec.ts` matched two elements                                                                                                                                                                                                                                                                                                                                           | locator excludes `#__next-route-announcer__`; still one app alert with the same message                                                                                                                          |
| Format check                                                   | 138 files                                  | unformatted code already on `dev`                                                                                                                                                                                                                                                                                                                                                                                                                                                          | one `prettier --write` pass (Prettier 3.9.5, the lockfile version), no other change in that commit                                                                                                               |

## Current state (this branch, local)

`pnpm audit --audit-level=high` · `format:check` · `typecheck` (18/18) · `test`
with `CI_REQUIRE_DB=1` (every package green) · `build` · mocked e2e (14/14) —
all pass. The hermetic
build suite (`hermetic-build.yml`) passes against real Docker.

Still skipped, and deliberately not touched here (existing 2026-09-18 decision):
two lifecycle-service and three verification-service route tests that
`paymentMiddleware` makes unreachable from `app.inject()`. `apps/web`'s `test`
script uses POSIX `NODE_OPTIONS=…` syntax, so it fails under `turbo` on Windows
only; CI is Linux.

## How regressions are caught now

- Every push to `dev` and `main`, and every PR, runs the full `ci` job.
- Changes to the worker, the builder image or the contracts also run
  `hermetic-build` (path-filtered, ~15 minutes).
- DB-backed suites fail instead of skipping when Postgres is missing
  (`CI_REQUIRE_DB=1`), so the M7 and budget SQL keep running against a real DB.

## Branch protection (repository settings, not code)

The YAML makes CI **run**; it does not make it **block**. That needs a maintainer
with admin rights, in Settings → Branches (or a ruleset) for `dev` and `main`:

1. Require a pull request before merging.
2. Require status checks to pass: **`ci`**. Do not make `hermetic-build` required
   — it is path-filtered, and a required check that never reports blocks merges.
3. Require branches to be up to date before merging.
4. Include administrators (or record why not).

This also answers V6 fact #2 / M9 in `docs/security-audit.md`: nothing in this
change turns branch protection on, and it has not been verified from here.

## Found while fixing, not changed here

Outside the scope of #427/#429; recorded so they are not lost.

- `processDeploymentJob` (policy-service) deploys without consuming the M2 deploy
  budget. It is not wired into any route or process today; if it is, route it
  through `deployPolicyInstance`, which enforces the budget.
- ~~`registerAdminDLQRoutes` treats every caller as `"default-admin"` when no
  `getAdminUser` is supplied.~~ Fixed (#746): `getAdminUser` is now required and
  registration throws `MissingAdminUserResolverError` without it. It is wired
  through `buildServer` only when `dlqStore` and `jobStore` are both supplied,
  and `index.ts` supplies neither today.
- policy-service signs CSRF tokens with a hard-coded fallback secret when
  `CSRF_SECRET` is unset; production should refuse to boot without one.
- lifecycle-service has an audit-log module but its server takes no audit
  dependency (tests were passing one that was silently ignored).
