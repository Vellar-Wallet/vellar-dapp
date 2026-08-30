# Observability (idea.md §13, technical-doc.md §10)

Vellar services expose Prometheus metrics + structured logs. The **instrumentation**
lives in the code (shared via `@vellar/service-kit`); **scraping + alerting** is an
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

**Standardized Metrics Naming Convention (Issue #300):**
All custom application metrics adhere to `vela_<subsystem>_<metric_name>_<unit_or_type>`:
- `<subsystem>`: identifies service component (`http`, `wallet`, `policy`, `worker`, `lifecycle`, `rpc`).
- `<metric_name>`: snake_case identifier (`created`, `passkey_auth`, `poison_messages`, etc.).
- `<unit_or_type>`: `_total` (counters), `_seconds` (durations/turnaround), `_depth` (queue sizes), `_lag_seconds` (processing lag).

**Domain Metrics, `_total` counters split by `outcome="success|failure"`:**

| Metric                                        | Emitted by        | §13 line / Subsystem              |
| --------------------------------------------- | ----------------- | --------------------------------- |
| `vela_wallet_created_total`                   | wallet-service    | wallet creation success rate      |
| `vela_wallet_passkey_auth_total`             | wallet-service    | passkey auth success/failure rate |
| `vela_wallet_tx_signed_total`                | wallet-service    | tx signing completion rate        |
| `vela_policy_deployed_total`                  | policy-service    | policy generation/deploy rate     |
| `vela_policy_poison_messages_total`           | policy-service    | event queue poison message count  |
| `vela_worker_verification_total`              | worker-service    | verification outcomes             |
| `vela_worker_verification_turnaround_seconds` | worker-service    | verification turnaround (hist.)   |
| `vela_lifecycle_cleanup_completed_total`      | lifecycle-service | cleanup completion rate           |
| `vela_rpc_errors_total{upstream}`             | wallet + worker   | RPC degradation / worker failures |
| `vela_worker_queue_depth`                     | worker-service    | queue depth (pending jobs)        |
| `vela_worker_processing_lag_seconds`         | worker-service    | submit-to-pickup processing lag   |

A "rate" is computed in the query layer, e.g. success rate over 5m:

```promql
sum(rate(vela_wallet_created_total{outcome="success"}[5m]))
/ sum(rate(vela_wallet_created_total[5m]))
```

## Logging

Structured JSON via pino (Fastify default).

### Request Middleware Logging (api-gateway)

The `api-gateway` request middleware emits structured JSON entries for all completed requests. Every entry includes `method`, `path`, `status`, and `duration` (in ms):

```json
{
  "level": 30,
  "time": 1772139600000,
  "pid": 4210,
  "hostname": "api-gateway",
  "reqId": "req-1",
  "method": "POST",
  "path": "/verification/submit",
  "status": 201,
  "duration": 18.4,
  "msg": "request completed"
}
```

This format allows log ingestion pipelines (Logstash, Vector, Datadog, Grafana Loki) to parse and filter API traffic without custom regex parsing.

### Domain Events

Domain events use the shared `logEvent(log, event, context)` helper so every event has a consistent `event` field for search. Durable audit trail (who/what/when for sensitive actions) stays in the `activity_logs` Postgres table — logs are for operational search, the audit table is the record of truth.

## Dashboard panels

### Latency Distribution Panel (`verification-service` p50, p95, p99)

Tracks request latency percentiles broken down by route using `vela_http_request_duration_seconds_bucket`:

```promql
# p50 (median) latency by route
histogram_quantile(0.50, sum(rate(vela_http_request_duration_seconds_bucket{service="verification-service"}[5m])) by (le, route))

# p95 latency by route
histogram_quantile(0.95, sum(rate(vela_http_request_duration_seconds_bucket{service="verification-service"}[5m])) by (le, route))

# p99 latency by route
histogram_quantile(0.99, sum(rate(vela_http_request_duration_seconds_bucket{service="verification-service"}[5m])) by (le, route))
```

Example Grafana panel definition:

```json
{
  "id": 1,
  "title": "verification-service Latency (p50, p95, p99)",
  "type": "timeseries",
  "targets": [
    {
      "expr": "histogram_quantile(0.50, sum(rate(vela_http_request_duration_seconds_bucket{service=\"verification-service\"}[5m])) by (le, route))",
      "legendFormat": "{{route}} - p50"
    },
    {
      "expr": "histogram_quantile(0.95, sum(rate(vela_http_request_duration_seconds_bucket{service=\"verification-service\"}[5m])) by (le, route))",
      "legendFormat": "{{route}} - p95"
    },
    {
      "expr": "histogram_quantile(0.99, sum(rate(vela_http_request_duration_seconds_bucket{service=\"verification-service\"}[5m])) by (le, route))",
      "legendFormat": "{{route}} - p99"
    }
  ],
  "fieldConfig": {
    "defaults": {
      "unit": "s"
    }
  }
}
```

### Worker Queue & Backpressure Panel (`worker-service`)

Tracks queue depth and processing lag to identify backlog accumulation before Stellar RPC limits are approached:

```promql
# Current queue depth
vela_worker_queue_depth{service="worker-service"}

# Current processing lag
vela_worker_processing_lag_seconds{service="worker-service"}
```

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
