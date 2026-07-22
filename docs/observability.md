# Observability (idea.md §13, technical-doc.md §10)

VELA services expose Prometheus metrics + structured logs. The **instrumentation**
lives in the code (shared via `@vela/service-kit`); **scraping + alerting** is an
ops concern you wire up in whatever monitoring system your hosting provides
(Grafana Cloud, a self-hosted Prometheus, Render/Fly metrics, etc.). This doc is
the contract between the two.

## Endpoints

Every service (and the build worker) exposes:

| Path       | Purpose                                    |
| ---------- | ------------------------------------------ |
| `/health`  | liveness — `{ status: "ok", service }`     |
| `/metrics` | Prometheus text exposition (scrape target) |

Ports: gateway `$PORT` (public); wallet 4001, lifecycle 4002, policy 4003,
verification 4004; **worker-service exposes `/health`+`/metrics` on
`WORKER_METRICS_PORT` (default 4005)** even though it serves no API — so a
scraper can watch it. In the `all-in-one` process, scrape the gateway's
`/metrics` (the shared registry is process-wide, labelled by `service`).

## Metrics

**HTTP (automatic, every service):**

- `vela_http_requests_total{service,method,route,status}` — request counter.
- `vela_http_request_duration_seconds{...}` — latency histogram. Routes are
  labelled by **pattern** (`/wallet/session/:id`), never the raw path, so path
  params don't blow up cardinality.

**Domain (idea.md §13), `_total` counters split by `outcome="success|failure"`:**

| Metric                                 | Emitted by        | §13 line                          |
| -------------------------------------- | ----------------- | --------------------------------- |
| `vela_wallet_created_total`            | wallet-service    | wallet creation success rate      |
| `vela_passkey_auth_total`              | wallet-service    | passkey auth success/failure rate |
| `vela_tx_signed_total`                 | wallet-service    | tx signing completion rate        |
| `vela_policy_deployed_total`           | policy-service    | policy generation/deploy rate     |
| `vela_verification_total`              | worker-service    | (verification outcomes)           |
| `vela_verification_turnaround_seconds` | worker-service    | verification turnaround (hist.)   |
| `vela_cleanup_completed_total`         | lifecycle-service | cleanup completion rate           |
| `vela_rpc_errors_total{upstream}`      | wallet + worker   | RPC degradation / worker failures |

A "rate" is computed in the query layer, e.g. success rate over 5m:

```promql
sum(rate(vela_wallet_created_total{outcome="success"}[5m]))
/ sum(rate(vela_wallet_created_total[5m]))
```

## Logging

Structured JSON via pino (Fastify default). Domain events use the shared
`logEvent(log, event, context)` helper so every event has a consistent `event`
field for search. Durable audit trail (who/what/when for sensitive actions)
stays in the `activity_logs` Postgres table — logs are for operational search,
the audit table is the record of truth.

## Recommended alert rules (§13 Alerting)

Wire these in your monitoring system against the metrics above. Thresholds are
starting points — tune to real traffic.

```yaml
# verification worker failures
- alert: VerificationWorkerFailures
  expr: increase(vela_rpc_errors_total{service="worker-service",upstream="build"}[10m]) > 3
  for: 5m

# RPC / Horizon degradation
- alert: RpcDegradation
  expr: increase(vela_rpc_errors_total{upstream="relayer"}[5m]) > 5
  for: 5m

# tx submission failure spike (idea.md: tx submission spikes/failures)
- alert: TxSubmitFailureSpike
  expr: |
    sum(rate(vela_tx_signed_total{outcome="failure"}[5m]))
    / clamp_min(sum(rate(vela_tx_signed_total[5m])), 1) > 0.2
  for: 10m

# abnormal cleanup failure rate
- alert: CleanupFailureRate
  expr: |
    sum(rate(vela_cleanup_completed_total{outcome="failure"}[15m]))
    / clamp_min(sum(rate(vela_cleanup_completed_total[15m])), 1) > 0.5
  for: 15m

# verification turnaround too slow (p95 > 5 min)
- alert: VerificationSlow
  expr: histogram_quantile(0.95, sum(rate(vela_verification_turnaround_seconds_bucket[30m])) by (le)) > 300
  for: 15m
```

## Example scrape config

```yaml
scrape_configs:
  - job_name: vela
    metrics_path: /metrics
    static_configs:
      - targets: ["gateway:4000", "worker:4005"] # all-in-one: just the gateway
```

## Honest scope

The instrumentation (endpoints, metrics, structured events) is built and tested.
Standing up Prometheus/Grafana and activating the alert rules above is
environment-dependent ops — the free-tier hosting has nowhere to run a scraper,
so this doc gives you everything needed to wire it wherever the app is deployed
for real, without pretending a monitoring stack exists.
