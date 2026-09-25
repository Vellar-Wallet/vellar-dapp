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

## Distributed Tracing (#301)

End-to-end trace visibility across service boundaries during policy generation and deployment flows is captured using OpenTelemetry-compatible trace spans via `@vellar/service-kit`:

### Trace Propagation Flow
1. **API Gateway (`api-gateway`)**: Injects or extracts `x-trace-id`, `x-span-id`, and W3C `traceparent` headers on incoming HTTP requests and proxies them to downstream services.
2. **Policy Service (`policy-service`)**: Extracts trace context from headers and wraps policy generation and deployment operations in `withTraceSpan("policy-service", "policy.deploy-instance", traceCtx)`. Propagates `traceId` with queued verification and deployment jobs.
3. **Worker Service (`worker-service`)**: Extracts `traceId` from claimed deployment jobs and executes verification in `withTraceSpan("worker-service", "policy.execute", traceCtx)`.

Trace spans are recorded in `TraceCollector` and exportable to OpenTelemetry APM backends (Jaeger, Zipkin, Datadog).

### Structured events

The following events are emitted via `logEvent()` for operational search and
analytics:

| Event Name | Emitted By | Trigger | Properties |
|---|---|---|---|
| `policy.deployed` | policy-service | Successful policy template deployment (POST /policies/deploy) | `policyId` (string), `templateType` (string, e.g. "spending_limit"), `walletId` (string, Soroban address), `deployedAt` (ISO 8601 timestamp) |

Example log line (JSON):
```json
{"level":"info","time":"2026-08-29T10:30:00.000Z","event":"policy.deployed","policyId":"550e8400-e29b-41d4-a716-446655440000","templateType":"spending_limit","walletId":"CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67","deployedAt":"2026-08-29T10:30:00.000Z"}
```

## Recommended alert rules (§13 Alerting)

The rules are wired for real in
[`infra/monitoring/vela-alerts.yml`](../infra/monitoring/vela-alerts.yml)
(Prometheus rule file, with severity labels, summaries and runbook links) and
routed by [`infra/monitoring/alertmanager/alertmanager.yml`](../infra/monitoring/alertmanager/alertmanager.yml):
`critical` → on-call webhook + Slack, everything else → Slack.

| Alert                        | Expression (abridged)                                                                 | For | Severity |
| ---------------------------- | ------------------------------------------------------------------------------------- | --- | -------- |
| `VelaServiceDown`            | `up{job=~"vela-.*"} == 0`                                                             | 2m  | critical |
| `VerificationWorkerFailures` | `increase(vela_rpc_errors_total{service="worker-service",upstream="build"}[10m]) > 3` | 5m  | warning  |
| `RpcDegradation`             | `increase(vela_rpc_errors_total{upstream="relayer"}[5m]) > 5`                          | 5m  | warning  |
| `TxSubmitFailureSpike`       | failure ratio of `vela_wallet_tx_signed_total` over 5m `> 0.2`                         | 10m | critical |
| `CleanupFailureRate`         | failure ratio of `vela_lifecycle_cleanup_completed_total` over 15m `> 0.5`             | 15m | warning  |
| `VerificationSlow`           | p95 of `vela_worker_verification_turnaround_seconds` over 30m `> 300`                  | 15m | warning  |

Thresholds are starting points — tune to real traffic. Note: an earlier version
of this section used pre-#300 metric names (`vela_tx_signed_total`,
`vela_cleanup_completed_total`, `vela_verification_turnaround_seconds`) that
match no emitted series; the rule file uses the current names.

## Running the monitoring stack

[`infra/monitoring/docker-compose.yml`](../infra/monitoring/docker-compose.yml)
runs Prometheus (scrape + rule evaluation), Alertmanager and Grafana (with the
`Vellar — Service Overview` dashboard provisioned from
`infra/monitoring/grafana/dashboards/`):

```sh
# secrets are files, never committed — see infra/monitoring/alertmanager/secrets/README.md
echo "https://hooks.slack.com/services/..." > infra/monitoring/alertmanager/secrets/slack_webhook_url
echo "https://events.pagerduty.com/..."     > infra/monitoring/alertmanager/secrets/oncall_webhook_url
docker compose -f infra/monitoring/docker-compose.yml up -d
# Prometheus :9090 · Alertmanager :9093 · Grafana :3001
```

Scrape targets live in
[`infra/monitoring/prometheus/prometheus.yml`](../infra/monitoring/prometheus/prometheus.yml)
and default to the local dev ports via `host.docker.internal`. For a deployed
environment, point them at the real hosts; for `all-in-one`, keep only the
gateway and the worker. Hosted Prometheus (Grafana Cloud, etc.) can import
`vela-alerts.yml` and the dashboard JSON as-is.

## Honest scope

The instrumentation (endpoints, metrics, structured events) is built and tested,
and the scrape/alert/dashboard configuration is committed under
`infra/monitoring/`. What remains environment-dependent is *where* that stack
runs: the free-tier hosting has nowhere to run a scraper, so a deployment must
either run the compose stack alongside the services or load the same rule file
and dashboard into a hosted Prometheus.
