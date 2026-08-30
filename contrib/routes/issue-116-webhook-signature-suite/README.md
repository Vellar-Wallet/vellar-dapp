# Mock route suite: webhook signature and replay checks (Issue #116)

Standalone mock route suite that verifies a webhook signature against a
fixed sample shared secret and rejects any payload whose id has already
been processed, simulating replay protection.

Processed ids are held in memory for the lifetime of the process. No chain,
RPC, or database access. The shared secret is a sample constant for local
testing, not a credential.

## Run

```sh
node route.mjs
# webhook-signature suite listening on http://localhost:4116
```

## Test

```sh
node route.test.mjs
```

## Signing

The signature is a hex HMAC-SHA256 of the canonical string `id.event`,
keyed by the shared secret `vellar_sample_webhook_secret`, sent in the
`x-vellar-signature` header:

```js
import { signPayload } from "./route.mjs";
signPayload({ id: "evt_001", event: "payment.settled" });
```

Signatures are compared with `crypto.timingSafeEqual`. The scheme is
deliberately minimal — it exists to exercise the accept and reject paths,
not to model a production signing scheme.

## Endpoints

### `POST /webhook/receive`

Accepts a signed webhook delivery.

Headers:

| Header | Required | Description |
| --- | --- | --- |
| `x-vellar-signature` | yes | Hex HMAC-SHA256 of `id.event` |

Body:

```json
{ "id": "evt_001", "event": "payment.settled" }
```

Response on a valid first delivery (`202`):

```json
{
  "accepted": true,
  "id": "evt_001",
  "event": "payment.settled",
  "processedCount": 1
}
```

Errors:

| Status | `error` | Cause |
| --- | --- | --- |
| 400 | `invalid_payload` | `id` or `event` missing or not a string |
| 401 | `missing_signature` | No `x-vellar-signature` header |
| 401 | `invalid_signature` | Signature does not match the shared secret |
| 409 | `replay_detected` | This `id` was already accepted |

The signature is checked before the replay check, so a delivery with a
forged signature never reveals whether an id has been seen. Rejected
deliveries are never recorded.

### `GET /webhook/processed-ids`

Returns the ids accepted so far, oldest first.

```json
{ "ids": ["evt_001", "evt_002"], "count": 2 }
```

Any other path returns `404` with `{ "error": "not_found" }`; a wrong
method on a known path returns `405` with `{ "error": "method_not_allowed" }`.

## Notes

`resetState()` is exported so a test can clear the processed-id set.

The folder is named `issue-116-webhook-signature-suite` to follow the
`contrib/routes/issue-<n>-<name>/` convention used by the sibling route
folders; the suite itself is the `webhook-signature-suite` described in the
issue.
