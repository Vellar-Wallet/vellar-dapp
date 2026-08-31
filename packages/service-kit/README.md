# @vellar/service-kit

Shared backend service bootstrap: health route, startup, graceful shutdown. Extracted once the second real service existed (see docs/decisions.md) so every `services/*` server stays consistent without copy-paste.

---

## Modules

### `registerHealth` / `startService`

Standard Fastify health-check route and graceful-shutdown wiring. See `src/index.ts`.

### `registerMetrics` / `recordOutcome`

Prometheus metrics (HTTP + domain counters). See `src/metrics.ts`.

### `resolvePersistencePolicy`

Fail-closed boot policy for the database layer. See `src/persistence.ts`.

### `resolveNetwork`

Explicit `STELLAR_NETWORK` resolution with cross-checks against passphrase and RPC URL. See `src/network-config.ts`.

### `SpendBudget` / `createPgSpendBudget`

Rolling-window spend budgets for the sponsor/deploy/create funding paths. See `src/budget.ts` and `src/pg-budget.ts`.

---

## `retryWithBackoff`

A general-purpose retry utility with **exponential back-off and full jitter** (issue #352). Use it anywhere an operation may fail transiently — RPC calls, Horizon HTTP fetches, DB writes under contention.

### API

```ts
import { retryWithBackoff, MaxRetriesExceededError, RetryAbortedError } from "@vellar/service-kit";

const result = await retryWithBackoff(fn, options);
```

**Parameters**

| Option | Type | Default | Description |
|---|---|---|---|
| `maxAttempts` | `number` | `4` | Total attempts (including the first call). Must be ≥ 1. |
| `baseDelayMs` | `number` | `200` | Base delay in ms. The ceiling for attempt N is `baseDelayMs × 2^N`. |
| `maxDelayMs` | `number` | `10 000` | Hard ceiling on any single sleep interval. |
| `noJitter` | `boolean` | `false` | When `true`, uses the full computed ceiling rather than a random value in `[0, cap]`. Only disable for deterministic tests. |
| `isRetryable` | `(err: unknown) => boolean` | `() => true` | Return `false` to surface an error immediately without further retries (e.g. 4xx HTTP errors). |
| `signal` | `AbortSignal` | — | Cancels pending retries. Throws `RetryAbortedError` when fired. |
| `sleep` | `(ms: number) => Promise<void>` | `setTimeout`-based | Override the sleep implementation (tests pass a zero-delay stub). |

**Thrown errors**

- `MaxRetriesExceededError` — all attempts exhausted. `.cause` is the last thrown error.
- `RetryAbortedError` — the `AbortSignal` fired between attempts.
- Any error for which `isRetryable` returned `false` — propagated as-is.

### Backoff formula

```
cap(N) = min(maxDelayMs, baseDelayMs × 2^N)   // N = 0-indexed attempt number
delay  = random(0, cap(N))                     // full jitter
```

Full jitter is recommended for production because it spreads retry storms across the window rather than synchronising all callers at the ceiling ([AWS Architecture Blog](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)).

### Examples

**Basic usage — retry a flaky RPC call**

```ts
import { retryWithBackoff } from "@vellar/service-kit";

const txStatus = await retryWithBackoff(() => rpcClient.getTransaction(hash), {
  maxAttempts: 5,
  baseDelayMs: 300,
  maxDelayMs: 3_000,
});
```

**Skip retries for permanent errors**

```ts
import { retryWithBackoff } from "@vellar/service-kit";

const data = await retryWithBackoff(() => fetchFromHorizon(url), {
  maxAttempts: 3,
  isRetryable: (err) => {
    // Abort immediately on 4xx — these are permanent client mistakes.
    if (err instanceof HttpError && err.status >= 400 && err.status < 500) return false;
    return true; // retry network errors and 5xx
  },
});
```

**Cancellable retry**

```ts
import { retryWithBackoff, RetryAbortedError } from "@vellar/service-kit";

const controller = new AbortController();
setTimeout(() => controller.abort(), 30_000); // overall deadline

try {
  const result = await retryWithBackoff(() => doWork(), {
    signal: controller.signal,
  });
} catch (err) {
  if (err instanceof RetryAbortedError) {
    // Cancelled — clean up.
  }
  throw err;
}
```

**Test-friendly — inject a zero-delay sleep**

```ts
import { retryWithBackoff } from "@vellar/service-kit";

it("retries on transient failure", async () => {
  let calls = 0;
  const result = await retryWithBackoff(
    async () => {
      if (++calls < 3) throw new Error("transient");
      return "ok";
    },
    { sleep: async () => {} }, // no real waiting in tests
  );
  expect(result).toBe("ok");
  expect(calls).toBe(3);
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
