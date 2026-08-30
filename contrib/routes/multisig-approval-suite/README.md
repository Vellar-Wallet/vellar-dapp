# Multisig Approval Suite

Standalone, dependency-free mock routes for proposing a transaction and collecting approvals from an allowlisted signer set. State is held in memory for the process lifetime; there is no chain, RPC, or database access.

## Run

```sh
node route.test.mjs
node route.mjs
```

The optional HTTP server listens on `http://localhost:4108` (or `PORT`). The exported `handleRequest` accepts `{ method, path, body, query }` and returns `{ status, body }`.

## Endpoints

### `POST /propose`

Body:

```json
{
  "transaction": { "to": "acct_demo", "amount": "25" },
  "signers": ["alice", "bob", "carol"],
  "threshold": 2
}
```

Creates a proposal and returns a `proposalId` with `201`. Signers must be unique non-empty strings, and `threshold` must be between `1` and the number of signers.

### `POST /approve`

Body:

```json
{ "proposalId": "prop_001", "signer": "alice" }
```

Records one approval when the signer is allowlisted. A signer can approve only once: a repeated approval returns `409 duplicate_approval`. An unknown signer returns `403 signer_not_allowed`. Successful responses include `approvalCount`, `threshold`, and `status`.

### `GET /status?proposalId=prop_001`

Returns the proposal's unique approvals and current status. The status is `pending` below the threshold and `ready` at or above it. Missing proposals return `404`.

Known endpoints reject the wrong HTTP method with `405`; unknown paths return `404`.