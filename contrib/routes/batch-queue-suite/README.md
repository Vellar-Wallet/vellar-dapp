# Batch Queue Suite

A standalone Node.js HTTP example that processes mock transaction batches in input order and retries failures. It uses only Node built-ins and keeps batch status in memory.

Run the tests with `node --test server.test.js`. Start the server with `node server.js`; it listens on `127.0.0.1:3003` by default, or on the port in `PORT`.

## Endpoints

### `POST /enqueue-batch`

Accepts a JSON body with a non-empty `items` array. Each item needs a string `id`; an item may also set `alwaysFail: true` to simulate a persistent failure. `failFirstAttemptFraction` is optional and defaults to `0.5`. The first `ceil(items.length * fraction)` items fail once and then succeed on retry. The fixed retry limit is two retries (three total attempts). The response includes a generated `batchId` and per-item final state, attempts, and state history.

### `GET /batch-status?batchId=batch-1`

Returns the stored batch and each item's `pending`, `retrying`, `succeeded`, or `failed` state history. Items still failing after the retry limit end in `failed`; an unknown batch ID returns `404`.
