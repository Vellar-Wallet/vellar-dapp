# Dead-Letter Queue (DLQ) Runbook for Policy Deployments

## Overview

The DLQ system prevents policy deployment jobs from retrying forever. When a job fails more than `MAX_RETRIES` times (default: 5), it's moved to an immutable dead-letter queue with an audit trail. Operators can then inspect the failure reason, fix root causes, and manually requeue jobs for retry.

**Key Metrics:**
- `dlq_enqueue_total{job_type="policy_deploy"}` — Jobs moved to DLQ
- `dlq_requeue_total{job_type="policy_deploy"}` — DLQ jobs requeued
- `dlq_depth_gauge{job_type="policy_deploy"}` — Current DLQ backlog

**Alert Rule:**
```
DLQHighDepth: sum(dlq_depth_gauge) > 10 for 10m
```

---

## Inspecting DLQ Entries

### Via Admin API

List all active DLQ entries:
```bash
curl -H "Authorization: Bearer <admin_token>" \
  https://api.example.com/admin/dlq?limit=50&offset=0
```

Get detailed view of a specific entry:
```bash
curl -H "Authorization: Bearer <admin_token>" \
  https://api.example.com/admin/dlq/<dlq_id>
```

Includes:
- Original job payload
- Failure reason (sanitized)
- Retry history and timestamps
- Audit trail of all requeue attempts

### Check Current Depth

```bash
curl -H "Authorization: Bearer <admin_token>" \
  https://api.example.com/admin/dlq-depth
```

Response:
```json
{
  "depth": 12
}
```

### Prometheus Queries

Active DLQ entries:
```promql
dlq_depth_gauge{job_type="policy_deploy"}
```

Rate of DLQ enqueues (jobs/minute):
```promql
rate(dlq_enqueue_total{job_type="policy_deploy"}[5m]) * 60
```

Rate of requeues (jobs/minute):
```promql
rate(dlq_requeue_total{job_type="policy_deploy"}[5m]) * 60
```

---

## Troubleshooting: Before Requeuing

### 1. Identify the Root Cause

Check the `last_error` field in the DLQ entry. Common failures:

| Error | Root Cause | Fix |
|-------|-----------|-----|
| `Sponsor account load failed` | Sponsor RPC connection down or account missing | Verify RPC health and sponsor account funded |
| `Policy deploy simulation failed` | Invalid constructor args (limit/window) | Check policy template args in database |
| `Deploy failed on-chain` | Insufficient sponsor balance | Fund sponsor account |
| `Deploy timeout` | Network congestion or RPC slow | Wait 5-10 minutes, then retry |
| `Contract id could not be read` | SDK parsing error (rare) | Upgrade SDK or contact support |

### 2. Verify External Dependencies

Before requeuing, verify these are healthy:

**RPC Endpoint:**
```bash
curl https://rpc-testnet.example.com/soroban/rpc/v1
# Should return 200 OK
```

**Sponsor Account Funded:**
```bash
curl https://rpc-testnet.example.com/soroban/rpc/v1 \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "getAccount",
    "params": ["G<sponsor_public_key>"]
  }'
# Check balance field
```

**Policy Template Valid:**
```bash
# Check policy definition in database
psql $DATABASE_URL -c "SELECT * FROM policies WHERE id = '<policy_id>';"
# Verify constructorArgs are valid JSON and within limits
```

### 3. Assess Business Impact

- Is this a critical policy deployment?
- Have any users complained about missing policies?
- What is the blast radius if it succeeds?

---

## Requeuing a DLQ Entry

### Manual Requeue (Recommended)

After verifying root cause is fixed:

```bash
curl -X POST \
  -H "Authorization: Bearer <admin_token>" \
  https://api.example.com/admin/dlq/<dlq_id>/requeue
```

Response:
```json
{
  "message": "DLQ entry requeued",
  "new_job_id": "550e8400-e29b-41d4-a716-446655440000",
  "dlq_id": "<dlq_id>"
}
```

**Idempotency:** Safe to retry this request if network fails. Automatically increments `requeue_count`.

### Monitor the Requeue

Tail logs for the new job:
```bash
stern "policy-service" -f | grep "new_job_id=550e8400"
```

Watch Prometheus dashboard for:
- `dlq_depth_gauge` decreases (job is processing)
- `dlq_requeue_total` counter increments
- No new enqueue events (job succeeded)

---

## Archiving Resolved DLQ Entries

After successful requeue and deployment:

```bash
curl -X POST \
  -H "Authorization: Bearer <admin_token>" \
  https://api.example.com/admin/dlq/<dlq_id>/archive
```

**Effect:**
- Entry hidden from default list view
- Appears in list only with `?archived=true` filter
- Audit trail preserved for compliance

---

## Batch Requeue (Multiple Failed Deployments)

If multiple deployments failed for the same reason (e.g., RPC downtime):

1. List DLQ with filter:
   ```bash
   curl -H "Authorization: Bearer <admin_token>" \
     'https://api.example.com/admin/dlq?job_type=policy_deploy&limit=100'
   ```

2. Identify entries with the same error pattern

3. Verify external dependencies are fixed

4. Requeue each entry:
   ```bash
   for dlq_id in $dlq_ids; do
     curl -X POST \
       -H "Authorization: Bearer <admin_token>" \
       https://api.example.com/admin/dlq/$dlq_id/requeue
     sleep 2  # Rate limit
   done
   ```

5. Monitor for requeue success:
   ```bash
   watch -n 5 'curl -s -H "Authorization: Bearer <token>" \
     https://api.example.com/admin/dlq-depth | jq .depth'
   ```

---

## Purging Old DLQ Entries

Entries remain in DLQ indefinitely for audit purposes. To clean up after retention period:

1. Archive successfully requeued entries (see above)

2. Query archived entries:
   ```bash
   curl -H "Authorization: Bearer <admin_token>" \
     'https://api.example.com/admin/dlq?archived=true&limit=100'
   ```

3. Manual cleanup via database (for retention compliance):
   ```bash
   psql $DATABASE_URL -c "
     DELETE FROM policy_deploy_dlq 
     WHERE archived = true 
       AND updated_at < now() - interval '90 days';
   "
   ```

**Note:** Archive before deleting to preserve audit trail.

---

## Responding to DLQHighDepth Alert

**Alert Condition:**
```
sum(dlq_depth_gauge) > 10 for 10m
```

**Steps:**

1. **Page on-call engineer** — DLQ buildup may indicate systemic issue

2. **Assess scale:**
   ```bash
   curl -H "Authorization: Bearer <admin_token>" \
     https://api.example.com/admin/dlq-depth
   ```

3. **Check recent errors:**
   ```promql
   # Prometheus: rate of new DLQ enqueues
   rate(dlq_enqueue_total{job_type="policy_deploy"}[5m]) * 60
   ```

4. **Identify patterns:**
   ```bash
   curl -H "Authorization: Bearer <admin_token>" \
     'https://api.example.com/admin/dlq?limit=50' | jq '.entries[].last_error' | sort | uniq -c | sort -nr
   ```

5. **Common Causes & Fixes:**

   | Pattern | Cause | Fix |
   |---------|-------|-----|
   | All errors: "Sponsor account load failed" | RPC endpoint down | Check RPC health, failover if needed |
   | "Deploy failed on-chain" (50%+) | Insufficient sponsor balance | Fund sponsor account |
   | "Policy deploy simulation failed" | Recent policy template change | Rollback template or fix args |
   | Mixed errors | Transient network issues | Wait 15 minutes, then batch requeue |

6. **Escalate if needed:**
   - Sponsor account exhausted → Finance team to fund
   - RPC systemic failure → Contact Stellar infrastructure team
   - Policy template bug → Engineering review required

---

## Key Invariants

### Safety Guarantees

1. **Exactly-once move to DLQ:** Job transitions to DLQ only once, atomically with status update
2. **Immutable history:** DLQ payload, error, and timestamps cannot be modified
3. **Audit trail:** All operations (enqueue, requeue, archive) logged with actor + timestamp
4. **Idempotent requeue:** Safe to retry requeue POST; creates no duplicate jobs
5. **No data loss:** Original job ID and full payload preserved for investigation

### Operational Invariants

1. **Retry budget:** Each job retried up to MAX_RETRIES times before DLQ
2. **Error sanitization:** PII (addresses, keys) redacted from error messages
3. **Deterministic backoff:** Exponential backoff (1s → 2s → 4s → 8s → 16s → 32s)
4. **Bounded cardinality:** Only `policy_deploy` job type (extensible for other queues)

---

## Monitoring Dashboard

Add to Grafana:

```json
{
  "panels": [
    {
      "title": "DLQ Depth",
      "targets": [{"expr": "dlq_depth_gauge{job_type=\"policy_deploy\"}"}],
      "type": "graph"
    },
    {
      "title": "DLQ Enqueue Rate (jobs/min)",
      "targets": [{"expr": "rate(dlq_enqueue_total{job_type=\"policy_deploy\"}[5m])*60"}],
      "type": "graph"
    },
    {
      "title": "DLQ Requeue Rate (jobs/min)",
      "targets": [{"expr": "rate(dlq_requeue_total{job_type=\"policy_deploy\"}[5m])*60"}],
      "type": "graph"
    }
  ]
}
```

---

## FAQ

**Q: A job failed for a transient reason (network glitch). Can I just requeue it?**  
A: Yes. Requeue is the primary recovery mechanism. Verify the root cause is transient and requeue.

**Q: What's the retention policy for DLQ entries?**  
A: Indefinite by default (audit trail). Archive and delete entries after 90 days if compliant with retention policy.

**Q: Can a job be requeued multiple times?**  
A: Yes. Requeue count is tracked in `requeue_count` field. Each requeue creates a fresh job with `retry_count=0`.

**Q: What happens if requeue fails?**  
A: The request returns an error, audit trail records the failure, and `requeue_in_progress` flag is reset. Safe to retry.

**Q: How do I know if a requeue succeeded?**  
A: Monitor the new job ID returned in the requeue response. Check logs or Prometheus metrics.

**Q: Can I delete a DLQ entry?**  
A: No. DLQ entries are immutable for audit purposes. Archive them instead.

---

## Support

- **Metrics dashboard:** See Grafana → Policy Service → DLQ
- **Alert playbook:** See `infra/monitoring/alerts.yaml`
- **Log search:** `stern "policy-service" | grep "dlq_move\|dlq_requeue"`
- **On-call runbook:** Escalate to engineering if depth remains > 50 for 1 hour
