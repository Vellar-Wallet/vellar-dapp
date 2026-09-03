# Exactly-Once Transaction Submission Worker (Issue #291)

## Overview

The transaction submission worker implements an **exactly-once SUBMISSION guarantee** using idempotent processing keyed on transaction ID. This prevents duplicate transaction submissions when the queue delivers the same message multiple times (network retries, worker crashes, visibility timeouts, etc.).

**Important**: This is an exactly-once SUBMISSION overlay on an at-least-once queue. It prevents *duplicate submissions* but does not prevent *duplicate confirmations* — if a transaction is confirmed on-chain twice in rare edge cases, we detect it but cannot undo the first confirmation.

## Architecture

### Processing Sequence

The worker enforces this atomic sequence to guarantee exactly-once submission:

```
1. Receive message from queue (do NOT ack yet)
2. Extract transaction ID from message
3. Check processed-message store:
   - If status = PROCESSED → log "duplicate detected" → ack → return
   - If status = IN_FLIGHT → log "in-flight duplicate" → ack → return
   - If not present → continue
4. Write IN_FLIGHT record to store (with 5-minute TTL) using SET NX
   - If SET NX fails → another worker claimed it → ack and return
5. Submit the transaction to the blockchain
6. On submission success:
   - Write PROCESSED record (with 48-hour TTL)
   - Ack the message
   - Return (no more retries)
7. On submission failure (transient):
   - Delete IN_FLIGHT record (or set to submitted)
   - Do NOT ack → queue redelivers based on retry policy
   - Log error with transaction ID
8. On submission failure (permanent):
   - Write FAILED record
   - Ack the message (do not retry)
   - Log error with transaction ID
```

### Processed-Message Store

The store tracks submission state using a PostgreSQL table: `transaction_submissions`

**Schema:**
```sql
CREATE TABLE transaction_submissions (
  transaction_id TEXT PRIMARY KEY,       -- Stellar transaction hash (idempotency key)
  status TEXT NOT NULL,                  -- 'submitted' | 'processing' | 'succeeded' | 'failed' | 'dead_letter'
  record JSONB NOT NULL,                 -- Full submission state (XDR, network, error, worker ID, etc.)
  created_at TIMESTAMPTZ NOT NULL,       -- First submission timestamp
  updated_at TIMESTAMPTZ NOT NULL,       -- Last status update
  expires_at TIMESTAMPTZ,                -- TTL expiration (NULL for non-expiring states)
  INDEX (status, created_at),            -- For polling/claiming
  INDEX (expires_at)                     -- For TTL cleanup
);
```

**Status Lifecycle:**
- `submitted` → `processing` (when worker claims it)
- `processing` → `succeeded` (after on-chain confirmation) OR `failed` (permanent error) OR `submitted` (transient retry)
- `succeeded` | `failed` → (terminal state, never reclaimed)
- `processing` → `dead_letter` (if max retries exceeded with transient errors)

**Record Structure (JSONB):**
```json
{
  "transactionId": "abc123...",
  "signedXdr": "AAAAAgAA...",
  "network": "testnet",
  "submitterType": "relayer" | "sponsor" | "hybrid",
  "attempts": 1,
  "workerId": "hostname-pid",
  "startedAt": "2026-08-28T17:30:45Z",
  "completedAt": "2026-08-28T17:30:47Z",
  "hash": "abc123...",  // Returned from blockchain
  "error": {
    "code": "submission_failed",
    "message": "RPC timeout",
    "context": { ... }
  }
}
```

### Atomic Operations

All state transitions use atomic SQL to prevent race conditions between concurrent workers:

1. **Check Status** (read-only): `SELECT status FROM transaction_submissions WHERE transaction_id = ?`
2. **Mark IN_FLIGHT** (atomic SET NX): `INSERT INTO transaction_submissions (...) VALUES (...) ON CONFLICT DO NOTHING RETURNING *`
   - If rows returned > 0: this worker claimed it
   - If rows returned = 0: conflict (another worker or existing state) — skip
3. **Mark PROCESSED** (update): `UPDATE transaction_submissions SET status = 'succeeded', expires_at = NOW() + 48h WHERE transaction_id = ?`
4. **Clear IN_FLIGHT** (update): `UPDATE transaction_submissions SET status = 'submitted', expires_at = NULL WHERE transaction_id = ?`

## Error Classification

Errors are classified as **transient** (retryable) or **permanent** (should not retry):

### Transient Failures (retry with backoff)
- Network timeouts: `TimeoutError`, `ETIMEDOUT`, connection issues
- Connection errors: `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND` (DNS)
- RPC errors: HTTP 429 (rate limit), 5xx, "syncing", "not ready", "temporarily unavailable"
- Sponsor submission: `sponsor_submit_failed` (transient RPC issue)
- Unknown errors: defaulted to transient (conservative approach)

### Permanent Failures (no retry)
- Invalid transaction: `sponsor_bad_tx`, `sponsor_simulation_failed`
- Budget exceeded: `sponsor_fee_too_high`, `sponsor_budget_exceeded`
- On-chain failure: `tx_failed` (already confirmed on-chain)
- Bad configuration: `relayer_not_configured`

**Classification Logic:**
```typescript
function isTransientSubmissionFailure(error: unknown): boolean {
  if (error instanceof SubmissionError) {
    // Check error code for known permanent codes
    if (PERMANENT_CODES.includes(error.code)) return false;
    // Check message for transient indicators
    if (message.includes("timeout") || message.includes("rate limit")) return true;
    // Default: transient
    return true;
  }
  // Network-level errors: transient by default
  return true;
}
```

## Exactly-Once Guarantee

### What it Provides

The system guarantees that a transaction will be submitted **at most once** to the blockchain during normal operation, even when:
- The queue redelivers the same message multiple times
- Multiple worker instances receive the same message simultaneously
- A worker crashes after submission but before acking

### Residual Risk (Known Limitation)

**If the worker crashes AFTER submission but BEFORE writing PROCESSED:**

1. The message stays in the queue (not acked)
2. Queue redelivers after visibility timeout
3. Second worker attempts submission
4. If the IN_FLIGHT record is still present (TTL not expired) → duplicate detected, skip
5. If the IN_FLIGHT record has expired → **potential duplicate submission**

**Probability of duplicate submission is low** because:
- IN_FLIGHT TTL (5 minutes) > expected max submission latency (~2 seconds)
- IN_FLIGHT TTL > typical queue visibility timeout (~30 seconds)
- Only occurs if both worker crashes AND TTL expires before redelivery

**Mitigation:**
- Set IN_FLIGHT TTL conservatively above p99 submission latency + redelivery delay
- Monitor submission latency (target < 2 seconds)
- Alert on unexpectedly long submissions
- Monitor queue redelivery delays

**This is NOT a full exactly-once DELIVERY guarantee** — it is a best-effort submission deduplication overlay. For full exactly-once semantics, use Stellar's sequence number checking (client-side).

## TTL Configuration

### IN_FLIGHT_TTL_MS = 5 minutes (300,000ms)

**Purpose:** Lock expiration for in-flight submissions. If a worker crashes, this TTL allows the message to be safely reprocessed after this delay.

**Calculation:**
- p99 submission latency (estimated): ~2 seconds
- Queue visibility timeout (assumed): ~30 seconds
- Redelivery delay buffer: ~1 minute
- **Total: ~2 minutes minimum**
- **Chosen: 5 minutes** (2.5x safety margin)

**[VERIFY] Before deployment:**
1. Monitor actual p99 submission latency in staging
2. Confirm queue visibility timeout setting
3. If p99 > 2 minutes, increase TTL to 2 × p99 + visibility_timeout
4. Document the actual values in your deployment

### PROCESSED_TTL_MS = 48 hours (172,800,000ms)

**Purpose:** Retain PROCESSED records to deduplicate redelivered messages. If a message is redelivered days later, we still detect and skip the duplicate.

**Calculation:**
- Queue message retention window (assumed): 24 hours
- Safety margin: 2x
- **Chosen: 48 hours**

**[VERIFY] Before deployment:**
1. Check your queue's message retention policy (e.g., SQS maxMessageAge, job queue retention, etc.)
2. Confirm PROCESSED_TTL_MS ≥ 2 × queue_retention
3. If your queue retains messages longer, increase PROCESSED_TTL_MS accordingly
4. Document the assumption in deployment notes

### Cleanup Policy

Expired records are cleaned up periodically:
- Processed (succeeded) records: deleted after PROCESSED_TTL expires
- In-flight (processing) records: deleted after IN_FLIGHT_TTL expires
- Failed records: **kept indefinitely** for audit/debugging

Cleanup runs on ~10% of worker ticks to avoid aggressive background scanning.

## Error Handling & Fail-Closed Policy

### Store Unavailability

**Policy: FAIL CLOSED** — Do not submit if the store is unavailable.

**Reasoning:** For financial transactions, the risk of duplicate submission > risk of delayed submission. Better to wait for the store to recover than to submit without idempotency guarantees.

**Behavior:**
- If database is down when checking status → worker throws → message not acked → queue redelivers
- If database is down when writing IN_FLIGHT → worker throws → message not acked → queue redelivers
- Worker logs the error and continues polling

**Alternative: Fail Open** (not recommended)
- Submit anyway without idempotency check
- Log a warning
- Risk: Duplicate submission if store is down for >IN_FLIGHT_TTL

We chose **fail closed** because:
1. Vellar is a financial product — duplicates are worse than delays
2. A short store outage is better than a permanent duplicate transaction
3. The queue will retry, and the store will likely recover by then
4. Operator alarms can alert on store unavailability

## Metrics & Observability

### Emitted Metrics

1. **submissionResult(outcome, durationMs)**
   - `outcome`: "succeeded" | "failed"
   - `durationMs`: time from receive to completion
   - Emitted on every submission attempt (success or permanent failure)

2. **submissionRetry(transactionId, retryCount, finalOutcome)**
   - `transactionId`: the Stellar tx hash (for tracing)
   - `retryCount`: number of retries before final outcome
   - `finalOutcome`: "succeeded" | "failed"
   - Emitted when a submission succeeds/fails after transient retries

3. **workerFailure(error)**
   - Emitted on unexpected worker errors (DB connection lost, etc.)
   - Includes error code and message

### Logs

All logs include:
- Transaction ID (for traceability)
- Status transition (e.g., "submitted → succeeded")
- Worker ID (hostname + pid, for multi-instance debugging)
- Error code and message (if applicable)

Example log output:
```
[SubmissionWorker] Processing transaction abc123... (attempt 1)
[SubmissionWorker] Successfully submitted abc123..., hash: def456...
[SubmissionWorker] Duplicate detected: transaction abc123... already succeeded; skipping
[SubmissionWorker] In-flight duplicate: transaction ghi789... being processed by another worker; skipping
[SubmissionWorker] Transient failure for jkl012...: timeout during RPC call; will retry
[SubmissionWorker] Permanent failure for mno345...: sponsor fee too high; marking as failed
```

## Configuration Constants

```typescript
// TTL values (see [VERIFY] notes above)
export const IN_FLIGHT_TTL_MS = 5 * 60 * 1000;        // 5 minutes
export const PROCESSED_TTL_MS = 48 * 60 * 60 * 1000;  // 48 hours

// Retry/backoff
export const MAX_SUBMISSION_ATTEMPTS = 3;             // Max claim attempts before dead-letter
export const EXPONENTIAL_BACKOFF_MS = [0, 1000, 2000]; // Delay per attempt (ms)

// Polling
export const POLL_IDLE_MS = 5000;                      // Delay when queue empty
export const POLL_BUSY_MS = 250;                       // Delay when work found
export const REAP_INTERVAL_MS = 5 * 60 * 1000;         // Cleanup frequency

// Worker identification
export const WORKER_ID = `${os.hostname()}-${process.pid}`;
```

All can be overridden via environment variables or function parameters.

## Integration with Existing Wallet-Service

The worker is designed as a complement to (not a replacement for) the current synchronous submission endpoint (`POST /wallet/submit`).

### Current Flow (Synchronous)
```
Client → POST /wallet/submit → Synchronous submission → Response (hash or error)
```

### Future Flow (With Worker, Optional)
```
Client → POST /wallet/submit-queued → Store in transaction_submissions table → Response (202 Accepted)
         ↓
Worker Poll Loop → Claim → Submit → Update status
         ↓
Client → GET /wallet/submission/:transactionId → Check status
```

The synchronous path can remain unchanged; the worker provides an alternative for scenarios requiring guaranteed retry semantics (e.g., high-latency networks, mobile clients with intermittent connectivity).

## Testing

### Unit Tests (Mock-Based)

Comprehensive test suite in `submission-worker.test.ts` covers:

1. **Error Classification** (8 tests): transient vs permanent classification
2. **Worker Logic** (9 tests): duplicate detection, transient/permanent handling, idempotency
3. **Store Operations** (5 tests): atomic read/write operations
4. **Backoff & Retry** (4 tests): retry decision and backoff behavior
5. **Exactly-Once Guarantee** (4 tests): duplicate submission prevention
6. **Error Handling & Metrics** (6 tests): logging, metrics emission, batch resilience
7. **Configuration** (6 tests): TTL values, polling intervals, max attempts
8. **Integration Scenarios** (5 tests): end-to-end flows

All tests use mocked store and submitter to isolate business logic from infrastructure.

### Integration Tests (Optional)

For deployment validation:
1. Spin up test environment with real PostgreSQL and Stellar testnet RPC
2. Submit a transaction via the worker
3. Verify idempotent behavior by resubmitting the same signed XDR
4. Confirm only one on-chain submission occurred
5. Monitor submission latency, TTL values, and cleanup

## Known Limitations & Future Work

1. **Exponential Backoff Not Yet Implemented:** The worker marks failed messages for retry but does not yet implement exponential backoff delays. This can be added by storing `nextRetryAt` in the record and filtering on poll.

2. **No Cross-Transaction Ordering:** The worker processes transactions in parallel (batch size configurable). If ordering matters (e.g., account sequence), add per-account FIFO queuing (like the cleanup worker).

3. **TTL Assumptions Require Verification:** The TTL constants are conservative but based on assumptions about p99 latency and queue retention. Deployment-time verification is required.

4. **Fail-Closed May Delay Submissions:** If the store is unavailable, submissions are delayed until recovery. For high-availability requirements, consider fail-open with warning logs and manual reconciliation.

5. **No Orphan Detection:** If a worker crashes after writing PROCESSED but the message is somehow redelivered (very rare), we would correctly deduplicate it. But if a transaction is confirmed on-chain but the record is deleted (e.g., cleanup runs too early), duplicate submission is possible. Monitor for orphans.

## [VERIFY] Checklist for Deployment

Before deploying the transaction submission worker, verify and document:

- [ ] **P99 Submission Latency**: Measure in staging; update IN_FLIGHT_TTL_MS if > 2 minutes
- [ ] **Queue Visibility Timeout**: Confirm value; ensure IN_FLIGHT_TTL_MS > visibility_timeout
- [ ] **Queue Message Retention**: Confirm value; ensure PROCESSED_TTL_MS ≥ 2 × retention
- [ ] **Database Connection Pooling**: Verify pool size, timeout, retry settings for production load
- [ ] **Stellar RPC Rate Limits**: Check rate limit headers; adjust backoff if necessary
- [ ] **Monitoring/Alerting**: Set up dashboards for submission latency, error rates, retry counts
- [ ] **Operator Runbooks**: Document procedures for store unavailability, stuck jobs, TTL adjustment
- [ ] **Load Testing**: Validate worker throughput with realistic transaction volume
- [ ] **Disaster Recovery**: Test recovery scenarios (worker crash, store crash, queue corruption)
- [ ] **Audit Trail**: Confirm activity_logs capture all submissions (success, failure, skip)

## References

- **Codebase**: 
  - `services/wallet-service/src/db/pg-tx-store.ts` — Store operations
  - `services/wallet-service/src/submission-error-classifier.ts` — Error classification
  - `services/wallet-service/src/worker/submission-worker.ts` — Worker loop
  - `services/wallet-service/src/worker/submission-worker.test.ts` — Test suite

- **Related Issues**:
  - Issue #295: Automatic retry with backoff for transient contract verification RPC failures
  - Issue #293: Out-of-order detection for lifecycle worker

- **Existing Patterns**:
  - `services/worker-service/src/loop.ts` — Verification worker polling loop
  - `services/lifecycle-service/src/worker/loop.ts` — Cleanup worker polling loop
