# Mock routes: export job queue (Issue #151)

Self-contained mock route suite that queues export jobs with a selected output
format and drains them strictly first-in-first-out, one at a time. All state is
held in process memory — no worker process, no storage, no chain access — so it
is for local UI/dev testing only.

## Run

```sh
node route.mjs
# export-queue-suite mock listening on http://localhost:4056
#   POST /export/enqueue
#   POST /export/process
#   GET  /export/queue-status
#   GET  /export/jobs/:jobId
```

Set `PORT` to use a different port.

## Test

```sh
node route.test.mjs
```

The first case enqueues two jobs and drains the queue, asserting that they
complete in the order they were enqueued and that only one is ever in flight.
Further cases cover queue positions shifting as the queue drains, format
validation, single-job lookup, and the idle/method/path guards.

## How the queue works

A job is `queued` on arrival. If the single processing slot is free, the head of
the queue is immediately promoted to `processing` — so at most one job is ever
in flight. Draining is driven explicitly by `POST /export/process` rather than
by a timer, which keeps the ordering observable and lets a test assert it
without waiting on the clock. Each completed job gets an `artifact` naming the
file the export would have produced.

```
enqueue A ─┐
enqueue B ─┴─> [processing: A] [queued: B]
process    ──> [completed: A]  [processing: B]
process    ──> [completed: A, B]  (idle)
```

## Endpoints

### `POST /export/enqueue`

| Field      | Type   | Required | Notes                                                     |
| ---------- | ------ | -------- | --------------------------------------------------------- |
| `format`   | string | yes      | `csv` or `json`; trimmed and lower-cased before matching.  |
| `resource` | string | no       | What is being exported. Defaults to `transactions`.        |

```sh
curl -s -X POST http://localhost:4056/export/enqueue \
  -H 'Content-Type: application/json' \
  -d '{"format":"csv","resource":"transactions"}'
```

```json
{
  "jobId": "exp_0001",
  "format": "csv",
  "resource": "transactions",
  "status": "processing",
  "sequence": 1
}
```

A job that has to wait comes back with `"status": "queued"` and a 1-based
`position` in the queue.

### `POST /export/process`

Completes the in-flight job and promotes the next one.

```json
{
  "completed": {
    "jobId": "exp_0001",
    "format": "csv",
    "resource": "transactions",
    "status": "completed",
    "sequence": 1,
    "artifact": { "filename": "transactions-exp_0001.csv", "contentType": "text/csv" }
  },
  "nowProcessing": {
    "jobId": "exp_0002",
    "format": "json",
    "resource": "balances",
    "status": "processing",
    "sequence": 2
  }
}
```

`nowProcessing` is `null` once the queue is empty.

### `GET /export/queue-status`

```json
{
  "processing": { "jobId": "exp_0001", "status": "processing", "...": "..." },
  "queued": [{ "jobId": "exp_0002", "status": "queued", "position": 1 }],
  "completed": [],
  "counts": { "processing": 1, "queued": 1, "completed": 0, "total": 2 },
  "allowedFormats": ["csv", "json"]
}
```

`queued` is in queue order and `completed` is in completion order, so the two
together show that jobs finish in the order they arrived.

### `GET /export/jobs/:jobId`

Returns a single job, for a client that holds a job id and wants to poll just
that one.

## Errors

| Status | `error`               | Cause                                                        |
| ------ | --------------------- | ------------------------------------------------------------ |
| 400    | `format_required`     | No `format` field (`allowedFormats` is echoed back)           |
| 400    | `invalid_format`      | `format` was not a string                                     |
| 400    | `unsupported_format`  | `format` was not in the allowed list                          |
| 400    | `invalid_resource`    | `resource` was present but not a string                       |
| 400    | `invalid_body`        | Body was not a JSON object                                    |
| 400    | `invalid_json`        | Body was not valid JSON                                       |
| 409    | `queue_idle`          | `POST /export/process` with nothing in flight                 |
| 429    | `queue_full`          | More than 100 jobs pending (`maxQueueLength` is echoed back)  |
| 404    | `job_not_found`       | Unknown job id                                                |
| 405    | `method_not_allowed`  | Path matched but the method did not                           |
| 413    | `body_too_large`      | Body exceeded 64 KiB                                          |
| 404    | `not_found`           | Unknown path                                                  |
