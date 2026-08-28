# Route suite: verification submission and status diff (Issue #94)

Self contained route handlers that walk a contract verification through
submission, a mock build, and a diff against a reference hash. Everything is
in memory in `route.mjs`. There is no real compiler, chain, or registry —
the "build" is a deterministic hash of the normalised source text, standing
in for reproducible build output.

## The stages

1. **Submit** (`POST /verify`) — record a contract id, the hash the caller
   claims their source produces, and the source itself. Queued; nothing is
   built yet.
2. **Build** (`POST /verify/:jobId/build`) — hash the submitted source. The
   same source always produces the same hash, so a build is reproducible.
   Refuses to re-run once a job has already built (`409 already_built`).
3. **Diff** (`GET /verify/:jobId/diff`) — compare the build hash against the
   reference hash on file for the contract id, and separately note whether
   the submitted hash matched what actually got built. Available only once a
   build has run (`409 not_built` before that).

The diff reports two independent comparisons, not one collapsed verdict:

- `submittedMatchesBuild` — did the caller's claimed hash match what their
  own source actually built to? A mismatch here means the submission itself
  was wrong, before the registry even enters the picture.
- `referenceMatch` — does the build match the reference hash on file? `null`
  (not `false`) when the contract id has no reference hash registered —
  "nothing to compare against" is a real, reportable state, not an error.

## Endpoints

### `POST /verify`

```json
{
  "contractId": "CONTRACT_KNOWN_GOOD",
  "submittedHash": "3e39e2294183941d80758367b1b8ecc4fbca4f8c2850003bcdfdd65d40bbb2b7",
  "source": "known-good source v1"
}
```

`submittedHash` must be an 8–64 character hex string. Returns `202` with the
queued job.

### `GET /verify/:jobId`

Reads back a job's current stage, its build result, and its diff result (all
`null` until each stage has run).

### `POST /verify/:jobId/build`

Runs the mock build. Whitespace in the source is normalised before hashing,
the way a real compiler's lexer would, so formatting alone never manufactures
a mismatch.

### `GET /verify/:jobId/diff`

```json
{
  "submittedHash": "3e39...",
  "buildHash": "3e39...",
  "referenceHash": "3e39...",
  "submittedMatchesBuild": true,
  "referenceMatch": true
}
```

| Response | Meaning                                                              |
| -------- | -------------------------------------------------------------------- |
| `202`    | Submitted                                                            |
| `200`    | Job read, build ran, or diff computed                                |
| `400`    | Malformed request (`contractId`, `submittedHash`, `source`, `jobId`) |
| `404`    | `job_not_found`                                                      |
| `409`    | `already_built` — build attempted twice                              |
| `409`    | `not_built` — diff attempted before a build ran                      |

## Run

```sh
node route.mjs
# verification-diff-suite mock listening on http://localhost:4094/verify
```

Override the port with `PORT=5000 node route.mjs`.

```sh
JOB=$(curl -s -X POST localhost:4094/verify \
  -H 'content-type: application/json' \
  -d '{"contractId":"CONTRACT_KNOWN_GOOD","submittedHash":"3e39e2294183941d80758367b1b8ecc4fbca4f8c2850003bcdfdd65d40bbb2b7","source":"known-good source v1"}' \
  | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4)

curl -X POST localhost:4094/verify/$JOB/build
curl localhost:4094/verify/$JOB/diff
```

## Test

```sh
node route.test.mjs
```

Covers the full lifecycle: a diff refused before any build, a build refused
to re-run once it has already run, a clean match against a registered
reference, a drifted reference producing a reported mismatch (and a
submitted hash that also turns out to be wrong), a contract id with no
reference on file reporting `null` rather than an error, whitespace
normalisation keeping a reformatted source's hash stable, and routing.
