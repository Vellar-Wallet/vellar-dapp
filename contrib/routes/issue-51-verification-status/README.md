# Mock route: verification job status (Issue #51)

Standalone mock GET route returning the status of a sample contract
verification job, looked up by a `jobId` path parameter. `status` is always one
of `pending`, `verified`, or `failed`. No real chain or database access.

## Run

```sh
node route.mjs
# verification-status mock listening on http://localhost:4051/verification-jobs/:jobId
```

## Test

```sh
node route.test.mjs
```

## Example

Request:

```
GET /verification-jobs/job_2002
```

Response:

```json
{
  "jobId": "job_2002",
  "status": "verified",
  "submittedAt": "2025-03-03T14:40:00Z",
  "completedAt": "2025-03-03T14:47:31Z",
  "message": "Wasm hash matches the published source"
}
```

A job that is still running has a `null` `completedAt`:

```json
{
  "jobId": "job_2001",
  "status": "pending",
  "submittedAt": "2025-03-04T09:12:00Z",
  "completedAt": null,
  "message": "Build queued"
}
```

A job id that isn't in the sample dataset returns a 404-style payload:

```
GET /verification-jobs/job_9999
```

```json
{
  "error": "not_found",
  "message": "No verification job found for id \"job_9999\""
}
```

## Sample dataset

| jobId      | status     |
| ---------- | ---------- |
| `job_2001` | `pending`  |
| `job_2002` | `verified` |
| `job_2003` | `failed`   |
