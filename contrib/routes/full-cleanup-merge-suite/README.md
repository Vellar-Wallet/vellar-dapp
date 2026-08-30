# Route suite: full cleanup and merge flow (Issue #124)

Self-contained route handlers that carry a sample account through
inspection, cleanup plan execution, verification of merge readiness,
and a final merge build as one connected sequence.

## Endpoints

### GET /inspect?account=<id>

Inspects the account and lists pending cleanup steps.

```json
{
  "account": { "account": "...", "balance": "1250.5000000", "flags": 1, "trustlines": 3, "signers": 2 },
  "pendingSteps": [
    { "id": "clear-flags", "description": "Clear account flags" },
    { "id": "remove-trustlines", "description": "Remove extra trustlines" },
    { "id": "lower-signers", "description": "Reduce signer count to 1" }
  ]
}
```

### POST /execute-cleanup-step

Executes a single cleanup step. State is tracked in memory per account.

Request:
```json
{ "account": "...", "step": "clear-flags" }
```

Response:
```json
{ "completed": true, "stepId": "clear-flags" }
```

### GET /check-ready?account=<id>

Checks whether all required cleanup steps have been completed.

```json
{ "ready": true, "completedSteps": [...], "missingSteps": [] }
```

### POST /build-merge

Builds the final merge transaction. Refuses to proceed unless
`/check-ready` reports the account is fully ready.

Request:
```json
{ "account": "..." }
```

Response (ready):
```json
{ "account": "...", "balance": "1250.5000000", "mergeTx": { "memo": "cleanup-merge", "ready": true } }
```

Response (not ready):
```json
{ "error": "not_ready", "missingSteps": ["clear-flags"] }
```

## Run

```sh
node route.mjs
# full-cleanup-merge-suite mock listening on http://localhost:4053
```

## Test

```sh
node route.test.mjs
```

The test walks an account through the full sequence: inspect → check-ready
(not ready) → build-merge (refused) → execute all steps → check-ready
(ready) → build-merge (success).
