# Route suite: blocker report (Issue #119)

Self-contained route handlers that inspect a sample Stellar account and
produce a prioritized report of blockers ranked by a fixed severity order.

## Endpoints

### GET /inspect?account=<id>

Inspects the given account and returns its profile plus raw list of blockers.

```json
{
  "account": { "account": "...", "balance": "1250.5000000", "trustlines": 3, "signers": 1, "flags": 0 },
  "blockers": [
    { "id": "excess-trustlines", "severity": "medium", "message": "..." }
  ]
}
```

### GET /report?account=<id>

Returns the same blockers as `/inspect`, but sorted by severity:
`high` first, then `medium`, then `low`.

```json
{
  "account": "...",
  "blockers": [
    { "id": "low-balance", "severity": "high", "message": "..." },
    { "id": "excess-trustlines", "severity": "medium", "message": "..." },
    { "id": "account-flagged", "severity": "low", "message": "..." }
  ]
}
```

## Severity levels

| Level  | Meaning |
|--------|---------|
| high   | Critical issue that blocks further action |
| medium | Warning that should be addressed |
| low    | Informational notice |

## Run

```sh
node route.mjs
# blocker-report-suite mock listening on http://localhost:4050
```

## Test

```sh
node route.test.mjs
```
