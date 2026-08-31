# @vellar/wallet-service

Wallet metadata, account preferences, session/device records, audit logs

## Deploy rollback runbook (#334)

### What this covers, honestly

The issue asks for blue/green environment support with a traffic cutover
step and automated rollback. This project deploys as a **single combined
process** (`@vellar/all-in-one`, which bundles this service) to Railway or
Render — see `railway.json` / `render.yaml` at the repo root — with no
orchestrator (no k8s/ECS; `infra/README.md`'s `k8s/` reference is aspirational,
not yet built) and no built-in traffic-splitting or dual-environment
primitive on either platform's free tier. A real blue/green cutover — two
live environments, a router that shifts traffic between them, automatic
rollback on a failed health check — isn't buildable against this infra today
without first standing up that orchestration layer, which is out of scope
for this issue.

What **is** real and shippable today: a documented, testable procedure for
verifying a new deploy before it's trusted, and a fast, deliberate rollback
path using the platform's native mechanisms. That's what's below.

### Pre-cutover health verification

Before treating a fresh deploy as live, gate it on
[`scripts/deploy-health-gate.ts`](../../scripts/deploy-health-gate.ts) —
it polls `/health` until it reports healthy for several checks in a row
(not just once, to rule out a service that's still flapping right after
startup):

```sh
tsx scripts/deploy-health-gate.ts \
  --url https://<your-deploy>.onrender.com/health \
  --consecutive 5 \
  --timeout-ms 120000
```

Exit code `0` means the deploy answered healthy 5 times in a row within two
minutes — safe to consider it the new "standby-verified" environment. Exit
code `1` means it never stabilized; do not point users at it, and go
straight to the rollback steps below.

`/health` here already reflects DB readiness, not just process liveness —
`registerHealth`'s `isReady` probe (`@vellar/service-kit`) returns 503 when
the persistence layer is degraded (FIX 7), so this gate genuinely verifies
the new deploy can serve real requests, not just that the process started.

### Rollback procedure

Both Railway and Render keep prior deploys and support rolling back to one
without a rebuild:

- **Render**: Dashboard → the service → **Deploys** tab → find the last
  known-good deploy → **Rollback to this deploy**. Render redeploys that
  exact build; no code change or push needed.
- **Railway**: Dashboard → the service → **Deployments** tab → find the last
  known-good deployment → the `⋮` menu → **Redeploy**. Same effect: the
  prior build goes live without a rebuild.

After rolling back, re-run the health gate against the now-live (rolled
back) URL to confirm the rollback itself is healthy before considering the
incident resolved:

```sh
tsx scripts/deploy-health-gate.ts --url https://<your-deploy>.onrender.com/health --consecutive 5
```

### Staging rehearsal

Because there's no separate blue/green environment to test cutover against,
rehearse the procedure end-to-end on a staging deploy before you need it for
real: deploy a change to staging, run the health gate against it, then
deliberately roll it back one step and re-run the gate against the rolled
-back build. If both gate runs pass, the rollback mechanism itself is
confirmed working — the actual "test the full cutover and rollback in a
staging environment" the issue asks for, scoped to what a single-environment
deploy target can rehearse.
