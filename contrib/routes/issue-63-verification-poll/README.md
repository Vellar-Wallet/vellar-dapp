# Mock route: verification submit + poll (Issue #63)

Standalone mock route module simulating contract verification: submit a
contract address to start a mock verification job, then poll the job
until it resolves. No real chain or database access -- jobs are held in
an in-memory `Map` that resets whenever the process restarts.

## Run

```sh
node route.mjs
# verification-poll mock listening on http://localhost:4063/verification/submit and /verification/status/:jobId
```

## Test

```sh
node route.test.mjs
```

## Endpoints

### `POST /verification/submit`

Starts a new verification job in the `pending` state.

Request:

```
POST /verification/submit
Content-Type: application/json

{ "contractAddress": "CABCD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGH" }
```

Response (`200`):

```json
{ "jobId": "job_1a2b3c4d5e6f", "status": "pending" }
```

### `GET /verification/status/:jobId`

Polls a job's status. To simulate real-world verification delay, a
`pending` job transitions to `verified` only after being polled **3
times** -- the first two polls report `pending`, the third (and every
subsequent) reports `verified`. The transition is one-way: once
`verified`, further polls stay `verified` with the same `verifiedAt`.

Response while pending (`200`):

```json
{ "jobId": "job_1a2b3c4d5e6f", "status": "pending", "pollCount": 1 }
```

Response once resolved (`200`):

```json
{
  "jobId": "job_1a2b3c4d5e6f",
  "status": "verified",
  "pollCount": 3,
  "verifiedAt": "2026-07-28T10:00:06.000Z"
}
```

Response for an unknown job id (`404`):

```json
{
  "error": "job_not_found",
  "message": "No verification job found for jobId \"job_does_not_exist\""
}
```

`route.test.mjs` submits a job and polls in a loop until it resolves,
asserting it takes exactly 3 polls and that the state stays `verified`
afterward.
