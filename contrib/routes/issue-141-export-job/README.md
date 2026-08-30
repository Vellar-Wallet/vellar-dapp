# Mock route: export job submission and polling (Issue #141)

Standalone mock route module simulating a data export job: submit an export
request to start a mock job, then poll the job until it completes. No real
chain or database access -- jobs are held in an in-memory `Map` that resets
whenever the process restarts.

## Run

```sh
node route.mjs
# export-job mock listening on http://localhost:4141/export/submit and /export/status/:jobId
```

## Test

```sh
node route.test.mjs
```

## Endpoints

### `POST /export/submit`

Starts a new export job in the `pending` state.

Request:

```json
{ "accountId": "acct_demo", "format": "csv" }
```

`format` is optional and defaults to `"csv"`.

Response (`200`):

```json
{ "jobId": "export_1a2b3c4d5e6f", "status": "pending" }
```

A missing `accountId` returns `400 invalid_request`.

### `GET /export/status/:jobId`

Polls a job's status. To simulate real-world export processing delay, a
`pending` job transitions to `complete` only after being polled **3
times** -- the first two polls report `pending`, the third (and every
subsequent) reports `complete` with a mock download url. The transition is
one-way: once `complete`, further polls stay `complete` with the same
`downloadUrl`.

Response while pending (`200`):

```json
{ "jobId": "export_1a2b3c4d5e6f", "status": "pending", "pollCount": 1 }
```

Response once complete (`200`):

```json
{
  "jobId": "export_1a2b3c4d5e6f",
  "status": "complete",
  "pollCount": 3,
  "completedAt": "2026-08-25T10:00:06.000Z",
  "downloadUrl": "https://mock-exports.example.com/downloads/export_1a2b3c4d5e6f.csv"
}
```

Response for an unknown job id (`404`):

```json
{
  "error": "job_not_found",
  "message": "No export job found for jobId \"export_does_not_exist\""
}
```

`route.test.mjs` submits a job and polls in a loop until it completes,
asserting it takes exactly 3 polls and that a download url is returned and
stays stable afterward.
