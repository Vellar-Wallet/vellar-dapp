# Mock route suite: signer expiration sweep job (Issue #120)

Standalone mock route suite simulating a periodic job that finds expired
signers and marks them removed, plus an endpoint to trigger that sweep
manually. Both endpoints accept a simulated current time so expiration can
be exercised without real delays.

State is held in memory for the lifetime of the process. No chain, RPC, or
database access — the signer list is fixed sample data.

## Run

```sh
node route.mjs
# signer-sweep suite listening on http://localhost:4120
```

## Test

```sh
node route.test.mjs
```

## Sample signers

| id | expiresAt |
| --- | --- |
| `signer_admin` | `null` (never expires) |
| `signer_session_a` | 2026-07-27T12:00:00.000Z |
| `signer_session_b` | 2026-07-27T18:00:00.000Z |
| `signer_device` | 2026-07-28T09:00:00.000Z |
| `signer_recovery` | 2026-08-04T00:00:00.000Z |

A signer is expired when `expiresAt` is at or before the simulated time
(the comparison is inclusive). A `null` `expiresAt` never expires.

## Endpoints

### `GET /signer-sweep/list-signers`

Lists every signer with its current sweep status.

| Query | Required | Description |
| --- | --- | --- |
| `now` | no | ISO 8601 simulated current time, defaults to the real clock |

Request:

```
GET /signer-sweep/list-signers?now=2026-07-27T20:00:00.000Z
```

Response (abridged):

```json
{
  "now": "2026-07-27T20:00:00.000Z",
  "signers": [
    {
      "id": "signer_session_a",
      "label": "Session key A",
      "expiresAt": "2026-07-27T12:00:00.000Z",
      "status": "active",
      "removedAt": null,
      "sweepPending": true
    }
  ],
  "activeCount": 5,
  "removedCount": 0,
  "sweepPendingCount": 2
}
```

`sweepPending` marks signers that are expired but not yet swept — that is,
what the next `run-sweep` at the same simulated time would remove.

### `POST /signer-sweep/run-sweep`

Runs the sweep once, marking every expired active signer as `removed` and
stamping `removedAt`.

Body (or the equivalent `now` query parameter):

```json
{ "now": "2026-07-27T20:00:00.000Z" }
```

Response:

```json
{
  "now": "2026-07-27T20:00:00.000Z",
  "sweepRun": 1,
  "removedCount": 2,
  "removedSignerIds": ["signer_session_a", "signer_session_b"],
  "remainingActive": 3
}
```

The sweep is idempotent for a given simulated time: running it again with
the same `now` returns `removedCount: 0`, since already-removed signers are
skipped. Advancing `now` sweeps whatever has expired since.

Errors:

| Status | `error` | Cause |
| --- | --- | --- |
| 400 | `invalid_now` | `now` is not a parseable ISO 8601 timestamp |

Any other path returns `404` with `{ "error": "not_found" }`; a wrong
method on a known path returns `405` with `{ "error": "method_not_allowed" }`.

## Notes

`resetState()` is exported so a test can restore the seed signer list and
replay sweeps from a known baseline.

The folder is named `issue-120-signer-sweep-suite` to follow the
`contrib/routes/issue-<n>-<name>/` convention used by the sibling route
folders; the suite itself is the `signer-sweep-suite` described in the
issue.
