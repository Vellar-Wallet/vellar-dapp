# Mock route: relayer submission fallback path (Issue #80)

Standalone mock route that simulates submitting a transaction through a
primary relayer, falling back to a secondary path when the primary reports
failure.

Nothing is actually submitted to a network. The mock secondary path always
succeeds; it exists to demonstrate the fallback flow, not to model a second
relayer's own failure modes.

## Run

```sh
node route.mjs
# relayer-fallback mock listening on http://localhost:4080/relayer/submit
```

## Test

```sh
node route.test.mjs
```

## Request

```json
{ "transaction": { "op": "payment", "amount": 10 }, "forcePrimaryFailure": false }
```

- `transaction` is required: a non-empty string (e.g. a signed XDR blob) or
  an object.
- `forcePrimaryFailure` is optional (default `false`) and forces the primary
  path to fail, for testing the fallback without a real primary outage.

## Response

```json
{
  "handledBy": "primary",
  "submissionId": "primary_1a2b3c",
  "attempts": [{ "path": "primary", "ok": true }]
}
```

`handledBy` is `"primary"` or `"fallback"`, indicating which path actually
handled the submission. `attempts` lists every path tried, in order, with its
outcome — one entry when the primary succeeds, two when it fails and the
fallback is used.

## Rejected requests

- `transaction` missing, empty, or not a string/object: `400 invalid_request`.
- `forcePrimaryFailure` present but not a boolean: `400 invalid_request`.
