# Issue 337 — Runbook: worker-service Queue Backlog Incident

Sandboxed operational runbook (per `contrib/README.md` — this repo has no
runbooks directory yet at all, confirmed by grep; see the PR description for
why this can't be added at, say, `docs/runbooks/` directly today) for a
`verification_records` queue backlog on `services/worker-service`.

## Background: what the "queue" actually is here

`worker-service` has **no message broker** — no Redis, no BullMQ, confirmed
by grep across `services/` and `packages/` (zero hits for
`redis`/`ioredis`/`bullmq`). The queue is the `verification_records` Postgres
table itself: rows move through the status enum
`unverified → submitted → building → verified | failed | dead_letter`
(`packages/types/src/index.ts`). The worker loop
(`services/worker-service/src/loop.ts`, wired from `src/index.ts`) polls that
table, atomically claims a `submitted` row (moves it to `building`), builds
it, and writes the result. A "backlog" here specifically means: rows are
piling up in `submitted` (or stuck in `building`) faster than the worker
process can drain them.

This matters for the runbook because the mitigation options are different
from a broker-backed queue: there's no separate broker to inspect, no
consumer group to rebalance — "scaling consumers" means running more
`worker-service` processes against the same Postgres table (each claims rows
atomically, so concurrent workers don't double-process), and "pausing
producers" means throttling or rejecting new `POST /verification/submit`
calls at the gateway/verification-service layer, not pausing a broker.

## 1. Detection signals

- **Primary metric** (already defined in `docs/observability.md`):
  `vela_verification_turnaround_seconds` — the histogram the worker emits via
  `WorkerMetrics.verificationResult()` (`services/worker-service/src/index.ts`).
  The existing alert `VerificationSlow` (p95 > 300s for 15m, per
  `docs/observability.md`'s "Recommended alert rules") is the closest existing
  precedent — a backlog manifests as this p95 climbing, since a row sitting in
  `submitted` waiting for a free worker adds directly to its own eventual
  turnaround time.
- **Queue depth**: count of rows in `submitted` + `building` status in
  `verification_records`. Not currently exposed as its own metric — until it
  is, the operational proxy is:
  ```sql
  SELECT status, count(*) FROM verification_records
  WHERE status IN ('submitted', 'building')
  GROUP BY status;
  ```
  run against the shared `DATABASE_URL` worker-service and
  verification-service both connect to.
- **The built-in backlog valve firing**: root `.env.example` already documents
  `VERIFY_QUEUE_MAX_ACTIVE` (default 1000) — "`/verification/submit` 429s past
  this many active records." A spike in `429` responses from
  `POST /verification/submit` at the gateway **is itself a backlog signal**:
  it means the active-record count already hit the configured ceiling before
  any human noticed. Watch gateway access logs / `domainMetrics` for a rise in
  429s on that route.
- **Reaper log noise**: `services/worker-service/src/index.ts`'s reaper
  (`runReaper`, on `VERIFY_REAP_INTERVAL_MS`, default 5m) logs
  `reaper: reclaimed X, dead-lettered Y` whenever it reclaims stranded
  `building` rows (past `VERIFY_REAP_TIMEOUT_MS`, default 15m) or dead-letters
  them after `VERIFY_MAX_ATTEMPTS` (default 3). A rising rate of reclaims is a
  symptom of workers dying or hanging mid-build (crash-looping, OOM,
  Docker/timeout issues) rather than simple under-capacity — worth
  distinguishing from "just needs more workers" (see Mitigation, below).
- **worker-service `/health`** (`WORKER_METRICS_PORT`, default 4005): the
  worker is still "healthy" per this endpoint even while backlogged — `/health`
  only reflects that the metrics Fastify app is up, not queue depth. **Don't
  rely on worker-service's own `/health` as a backlog signal** — it will stay
  green through an entire backlog incident. Use the metric/valve/SQL signals
  above instead.

## 2. Mitigation

### 2a. Scale consumers (the primary lever)
Run additional `worker-service` processes pointed at the same
`DATABASE_URL`. Because the job store claims rows via an atomic Postgres
update (`services/worker-service/src/pg-job-store.ts`), multiple worker
processes are safe to run concurrently against the same table without extra
coordination — this is the intended scale-out path, not a workaround.
```sh
# example: run two additional worker processes locally/in an environment
# that supports it (each just needs the same DATABASE_URL + build image config)
DATABASE_URL=$SHARED_DB_URL VERIFY_BUILD_IMAGE=vela-verify:1.94.0 \
  pnpm --filter @vellar/worker-service start &
DATABASE_URL=$SHARED_DB_URL VERIFY_BUILD_IMAGE=vela-verify:1.94.0 \
  pnpm --filter @vellar/worker-service start &
```
In a container/orchestrated deployment (this repo currently ships
`render.yaml`/`railway.json` for the combined `all-in-one` process — see
`infra/README.md` for the stated future direction toward `k8s/` manifests),
this is simply increasing the worker-service replica count.
**Caveat**: each worker runs real Docker builds under resource caps
(`VERIFY_BUILD_MEMORY`/`VERIFY_BUILD_CPUS`/`VERIFY_BUILD_PIDS_LIMIT`, default
`2g`/`2`/`512`, per `services/worker-service/README.md`) — scaling worker
*count* on a single host multiplies that resource footprint; make sure the
host actually has capacity before adding replicas, or backlog mitigation
becomes a new host-resource incident.

### 2b. Pause / throttle producers
Since there's no broker to pause, this means reducing inbound
`POST /verification/submit` load at the source:
- **Lower `VERIFY_QUEUE_MAX_ACTIVE`** temporarily (env var on
  verification-service/gateway) so the existing 429 valve engages sooner,
  shedding load before the backlog gets worse, buying the scaled-up workers
  (2a) time to drain the existing backlog.
- If the backlog is driven by a specific abusive/misbehaving caller (e.g. a
  script retrying submissions in a loop), tighten the rate limit at the
  `api-gateway` layer: `services/api-gateway/src/server.ts` already registers
  `@fastify/rate-limit` gateway-wide (`RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`
  env vars, default 120 req/60s, with `/health` explicitly exempted via its
  `allowList`). This incident is exactly the case for lowering
  `RATE_LIMIT_MAX` temporarily, or adding a route-specific limit on
  `/verification/submit` if the existing gateway-wide limit isn't tight
  enough to shed the specific abusive load.
- Communicate to callers (internal or external, depending on how
  `/verification/submit` is exposed) that submissions are being throttled,
  so retries don't compound the backlog further.

### 2c. Investigate and fix a stuck-worker root cause (if reaper reclaims are high)
If detection signals point to workers dying/hanging (high reaper reclaim
rate) rather than simple under-capacity, scaling consumers alone won't help —
more workers just means more workers eventually hanging too. Check:
- Docker build logs for the specific failing submissions (a SIGKILL exit
  specifically means the build hit `VERIFY_BUILD_TIMEOUT_S` — default 600s —
  or a memory/pids cap, not a code error).
- Whether a specific repo/commit submitted for verification is pathological
  (e.g. genuinely needs more than the default resource caps, or its
  dependencies aren't vendored and fail hard against the build's
  `--network=none` sandbox).
- `VERIFY_MAX_ATTEMPTS` (default 3): if many rows are landing in
  `dead_letter`, that's the reaper doing its job correctly (per
  `services/worker-service/src/index.ts`'s comment: "so a mid-build crash
  can't strand a job forever") — those rows need resubmission after the root
  cause is fixed, not further worker scaling.

## 3. Escalation

This repo has no formal on-call rotation documented today (confirmed:
no `CODEOWNERS`, no on-call config found). Until one exists:
- **Primary escalation**: the repo maintainer, `davedumto` (the only account
  exempted from the `main`-targeting and `contrib/`-only PR guards per
  `.github/workflows/close-prs-to-main.yml` and
  `.github/workflows/close-prs-outside-contrib.yml` — i.e., the de facto
  owner/operator of this codebase).
- **Community channel**: the Telegram group linked from `CONTRIBUTING.md` and
  `contrib/README.md` (`https://t.me/+RWPCKXXJTj45Njk0`) is this project's
  documented communication channel for anything that isn't a GitHub issue.
- **Escalate when**: `VERIFY_QUEUE_MAX_ACTIVE`'s 429 valve has been engaged
  for more than ~15 minutes (matching the existing `VerificationSlow` alert's
  15-minute window in `docs/observability.md`, for consistency with an
  established threshold in this repo) without the backlog visibly draining
  after mitigation steps 2a/2b have been applied, or if 2c reveals a
  potential security concern (e.g. a submission designed to exhaust build
  resources) rather than an ordinary capacity issue.

## 4. Rollback steps

"Rollback" here means: once the backlog is drained and root cause addressed,
undo any temporary mitigation so the system returns to its normal operating
configuration — don't leave throttled settings in place indefinitely:

- [ ] **Restore `VERIFY_QUEUE_MAX_ACTIVE`** to its normal value if it was
      lowered in step 2b — confirm the queue depth (§1's SQL query) has been
      stable near zero for a reasonable window first (e.g. 30+ minutes) before
      relaxing the valve back.
- [ ] **Scale worker-service replica count back down** to its normal steady
      state if it was scaled up in 2a purely to drain a one-off backlog spike
      (as opposed to a durable increase in submission volume, in which case
      the new replica count should become the new baseline, not a rollback
      target).
- [ ] **Undo any emergency rate-limit/block** applied at the gateway in 2b
      once the misbehaving caller (if any) has been confirmed fixed/blocked
      properly, rather than leaving an ad hoc rule in place.
- [ ] **Resubmit dead-lettered rows** (status `dead_letter`) that failed only
      because of the backlog/root-cause condition, once it's confirmed fixed —
      dead-lettering is terminal (the reaper never retries a `dead_letter`
      row on its own; see `services/worker-service/src/index.ts`), so this
      needs an explicit resubmission via `POST /verification/submit` for each
      affected `contractId`.
- [ ] **Re-run the pre-deploy smoke test** (issue #339's
      `contrib/routes/issue-339-predeploy-smoke-test/`) against the recovered
      environment to confirm all services (including worker-service's own
      `/health` on `WORKER_METRICS_PORT`) are reporting healthy before closing
      the incident.
- [ ] **Note the incident** for future reference (see issue #340's runbook for
      the same caveat about `docs/decisions.md` being gitignored on `main`) —
      capture the peak queue depth, what mitigation actually resolved it, and
      whether it revealed a genuine capacity gap (permanent fix: raise steady-
      state worker replica count) vs. a one-off (e.g. a single bad submission).
