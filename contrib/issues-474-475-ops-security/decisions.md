# Decisions log

Operational and architectural decisions that don't fit in code comments or a
single PR description. Each entry is dated and says what was decided, why,
and what (if anything) is still open.

## 2026-10-24: SPOF triage (Issue #474)

Single points of failure identified in `docs/open-work-catalogue.md`, triaged
one by one. "Accept" means the risk is understood and deliberately not
mitigated right now; "mitigate" reduces blast radius without eliminating the
SPOF; "eliminate" removes the single point of failure.

| SPOF | Decision | Rationale | Status |
|---|---|---|---|
| Sponsor secret key | **Mitigate** | Spend caps already exist (see `security-audit.md` C1/H1). Full elimination needs a multisig or HSM-backed signer, which is a larger infra change than this pass covers. | Rotation procedure below; hard ceiling already in place via spend budgets. Key splitting/HSM tracked as follow-up, not closed here. |
| npm publish rights (`vellar-sdk`) | **Mitigate** | A compromised publish reaches every consumer automatically via the `^0.6.2` caret range in `apps/web/package.json` and `apps/extension/package.json`. 2FA and npm provenance attestation are the standard mitigation that doesn't require process restructuring. | 2FA + provenance to be enabled on the npm account (ops action, not a code change, tracked as open below). Exact pinning left as a judgment call for each consuming app's maintainer, since caret ranges are also how security patches reach consumers automatically. |
| Render account / DNS | **Mitigate** | No code-level fix exists for "one person holds the account." The practical mitigation is a documented recovery path. | See recovery procedure below. Full elimination (shared/org-owned account) is an ops decision outside this repo's scope. |
| M5 multisig attestor | **Accept (tracked separately)** | Already tracked as a named mainnet blocker in `docs/security-audit.md` M5. Not re-litigated here to avoid two sources of truth for the same item. | Open, see `security-audit.md` M5. |

### Sponsor secret key rotation procedure

1. Generate a new Stellar keypair offline (never paste a secret key into a
   chat, ticket, or non-secret-manager tool).
2. Fund the new sponsor account with the operational balance currently held
   by the old one, plus enough margin to cover in-flight transactions during
   the cutover window.
3. Set the new key as `SPONSOR_SECRET_KEY` in the Render dashboard
   (`sync: false`, per `render.yaml`); do not commit it.
4. Deploy with the new key active; monitor wallet creation and submission
   for the next full billing/spend-budget cycle to confirm the new key is
   correctly bounded by the existing spend caps.
5. Once confirmed healthy, drain and retire the old sponsor account's
   remaining balance back to a cold wallet; do not leave a funded, unused
   key active.
6. Record the rotation date here (append a new dated entry) each time this
   runs, so bus-factor coverage for "who last rotated this and when" doesn't
   depend on one person's memory.

**Trigger conditions for an unscheduled rotation** (not just periodic): any
suspected compromise, any departure of the person who held the key, or any
exposure of the secret in a log, screenshot, or shared terminal session.

### Render / DNS account recovery path

- The Render account and the domain registrar/DNS provider should each have
  a second administrator added (not just a password shared informally,
  which doesn't survive the primary holder's unavailability and has no
  audit trail).
- If a second admin cannot be added immediately, the primary holder should
  document, in a location the team already trusts for secrets (not this
  file, which is public in the repo), the recovery email and 2FA recovery
  codes for both accounts.
- This decision intentionally stops short of naming who the second admin
  is or storing any credential here; that's an ops action for whoever
  holds the accounts today, not something this PR can execute.

### Still open after this pass

- 2FA + npm provenance enablement on the `vellar-sdk` publish account:
  requires access to that npm account, not actionable from this repo.
- Adding a second Render/DNS administrator: requires access to those
  dashboards, not actionable from this repo.
- M5 multisig attestor: tracked in `security-audit.md`, unchanged by this
  entry.

## 2026-10-24: Free-tier Postgres expiry (Issue #475)

`render.yaml`'s free Postgres (`vellar-db`) expires 30 days after creation
(14-day grace period). This entry records the triage; it does **not**
record an actual migration, since that requires provisioning a real Neon
(or equivalent) database and rotating `DATABASE_URL` on the live Render
deploy, both of which need dashboard/account access this pass doesn't have.

### What was verified in this pass

- The RA-4 fail-closed boot guard (`packages/service-kit/src/persistence.ts`,
  closed per `security-audit.md` RA-4) was re-run: `pnpm test persistence`
  in `packages/service-kit` passes all 9 cases, confirming an unset
  `NODE_ENV` (the real deploy-target condition on Render) refuses to boot
  on in-memory storage rather than silently degrading. This directly
  answers the "boot guard verified to fail closed" acceptance item: **it
  already does**, as of the RA-4 fix; this entry just re-confirms it still
  holds.
- Confirmed `wallet-service`, `policy-service`, and `verification-service`
  (the three services with persistent state) each wire
  `resolvePersistencePolicy` at their own module top level and `process.exit(1)`
  on a `fail` decision. `lifecycle-service` has no persistence code at all by
  design (it only builds/plans/queries Horizon; it holds no durable state to
  guard). `services/all-in-one/src/index.ts`, the combined process
  `render.yaml` actually deploys (`pnpm --filter @vellar/all-in-one start`),
  imports all four as self-starting top-level-await modules, so the guard in
  each one does run during the combined boot sequence; there's no separate
  wiring to audit in `all-in-one` itself.
- **Gap found, not closed in this pass**: `services/all-in-one` has no test
  of its own, and nothing anywhere in the repo spawns the actual boot
  sequence as a subprocess to confirm the `process.exit(1)` fail-closed path
  fires end-to-end (the existing `persistence.test.ts` tests only the pure
  decision function, never the real exit). Writing that safely means
  spawning `tsx src/index.ts` as a child process with `DATABASE_URL` unset
  and `NODE_ENV` unset, and asserting a non-zero exit code within a timeout.
  That is a real integration test, not a unit test, and one this pass
  didn't want to rush given `all-in-one` starts five services' worth of
  dependencies.
  Left as a follow-up rather than merged half-verified.

### What is still required (not done in this pass)

1. **Establish the current database's actual creation date.** This is only
   visible in the Render dashboard (Render doesn't expose it via
   `render.yaml` or any file in this repo), so it cannot be determined from
   the codebase alone. Whoever has dashboard access should check this
   first, since it determines how urgent the remaining steps are.
2. **Provision a non-expiring Postgres** (Neon, per `render.yaml`'s own
   suggestion, or any other non-expiring provider) and set its connection
   string as `DATABASE_URL` in the Render dashboard (`sync: false`,
   matching the existing `SPONSOR_SECRET_KEY`/`RELAYER_API_KEY` pattern).
3. **Migrate the data**, with particular attention to the keyId→contractId
   mapping table (`POST /wallet/connect` depends on it directly; without
   it, reconnecting wallets fail with `wallet_not_found`). A dry-run
   restore into the new database, followed by a row-count and spot-check
   comparison against the old one, should happen before cutting over
   `DATABASE_URL`.
4. **Confirm a backup exists** before migrating; migrating without one
   risks permanent loss of the wallet mapping if the migration itself goes
   wrong.
5. **After cutover**, re-run the same `persistence.test.ts` verification
   style check against the live service (i.e. confirm the new
   `DATABASE_URL` is reachable and the service reports `use-postgres`, not
   `allow-inmemory`, at boot) rather than assuming the dashboard wiring is
   correct.

This is deliberately left as an explicit, ordered checklist rather than
closed, since steps 1-4 require Render/Neon dashboard access this pass
doesn't have. The code-verifiable half of the issue (the boot guard itself)
is confirmed working; the infra half is not yet done.
