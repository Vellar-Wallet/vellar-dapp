# @vellar/service-kit

Shared backend service bootstrap: health route, metrics exposition, correlation ID propagation, startup, and graceful shutdown across all Vellar microservices (`wallet-service`, `policy-service`, `worker-service`, `lifecycle-service`, `verification-service`).

## Features

- **Health Checks**: Standardized `/health` endpoint with optional readiness probes.
- **Prometheus Metrics**: Automatic HTTP request counting and duration histograms via `/metrics`.
- **Standardized Metrics Naming (#300)**: Shared convention and linter for cross-service observability.
- **Correlation ID Propagation (#299)**: End-to-end distributed tracing across HTTP requests, enqueued background jobs, and structured log entries.
- **Spend Budgets**: Sliding-window spend budgeting for relayer and sponsor protection.
- **Persistence Policies**: Safe fail-closed initialization and DB connection management.

---

## Metrics Naming Convention (#300)

All Vellar services adhere to a unified Prometheus metric naming structure to ensure consistency across dashboards, alerts, and log aggregators:

```
vela_<subsystem>_<metric_name>_<unit_or_type>
```

### Components

1. **Namespace**: Must always be `vela_`.
2. **Subsystem**: Identifies the service or architectural subsystem (e.g. `http`, `wallet`, `policy`, `worker`, `lifecycle`, `rpc`).
3. **Metric Name**: Snake_case identifier describing the signal (e.g. `created`, `passkey_auth`, `verification_turnaround`, `poison_messages`).
4. **Unit / Suffix**:
   - `_total`: Counters (monotonically increasing event counts).
   - `_seconds`: Latencies, durations, turnaround timings.
   - `_bytes`: Payload sizes, memory usage.
   - `_depth`: Queue backlogs, item counts in queues.
   - `_lag_seconds`: Processing delays, time offsets between submission and consumption.
   - `_count` / `_ratio` / `_info` / `_status`: Gauges and categorical representations.

### Examples

- `vela_http_requests_total`
- `vela_http_request_duration_seconds`
- `vela_wallet_created_total`
- `vela_wallet_passkey_auth_total`
- `vela_wallet_tx_signed_total`
- `vela_policy_deployed_total`
- `vela_policy_poison_messages_total`
- `vela_worker_verification_total`
- `vela_worker_verification_turnaround_seconds`
- `vela_worker_queue_depth`
- `vela_worker_processing_lag_seconds`
- `vela_lifecycle_cleanup_completed_total`
- `vela_rpc_errors_total`

### Validation & Linting

`@vellar/service-kit` exports validation helpers to enforce naming compliance programmatically:

```typescript
import { validateMetricName, lintMetricNames, metricsRegistry } from "@vellar/service-kit";

// Validate a single metric name
const result = validateMetricName("vela_wallet_created_total");
if (!result.valid) {
  throw new Error(result.reason);
}

// Lint all registered metrics in a test suite
const { valid, violations } = lintMetricNames(metricsRegistry());
expect(valid).toBe(true);
```

---

## Correlation ID Propagation Convention (#299)

To trace operations across microservices and async background workers:

1. **HTTP Inbound**: Every incoming request inspects `x-correlation-id` (falling back to `x-request-id`). If omitted by the client, a UUID is automatically generated.
2. **HTTP Outbound**: The correlation ID is reflected on the response via the `x-correlation-id` header.
3. **Enqueued Jobs**: Any job or task enqueued from an HTTP request (such as wallet-to-worker tasks or verification jobs) must carry `correlationId` in its payload.
4. **Structured Logging**: All log entries and audit events emitted during the request or job lifecycle include `correlationId` in their metadata.

### Usage

```typescript
import Fastify from "fastify";
import { registerCorrelationId } from "@vellar/service-kit";

const app = Fastify({ logger: true });
registerCorrelationId(app);

app.post("/wallet/jobs", async (request, reply) => {
  // request.correlationId is automatically populated
  await jobQueue.enqueue({
    recordId: "job-123",
    correlationId: request.correlationId,
  });

  request.log.info({ correlationId: request.correlationId }, "job enqueued");
  return reply.send({ ok: true });
});
```
