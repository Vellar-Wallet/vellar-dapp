# Mock route suite: webhook delivery with signature rotation (Issue #146)

Standalone mock route suite that delivers a mock webhook signed with a
rotating shared secret, and verifies a received payload against the
currently active secret. Signatures produced under a secret that has since
been rotated out are rejected. In-memory only, no chain, RPC, or database
access. State resets whenever the process restarts.

## Run

```sh
node route.mjs
# webhook-signature-suite listening on http://localhost:4146
```

## Test

```sh
node route.test.mjs
```

## Signing

The signature is a hex HMAC-SHA256 of the canonical string `id.event`, keyed
by the currently active secret:

```js
import { signPayload } from "./route.mjs";
signPayload({ id: "evt_001", event: "payment.settled" });
```

Signatures are compared with `crypto.timingSafeEqual`. The scheme is
deliberately minimal — it exists to exercise delivery, rotation, and
verification, not to model a production signing scheme.

## Endpoints

### `POST /webhook/deliver`

Simulates a webhook delivery signed with the active secret.

Headers:

| Header               | Required | Description                                               |
| -------------------- | -------- | --------------------------------------------------------- |
| `x-vellar-signature` | yes      | Hex HMAC-SHA256 of `id.event`, keyed by the active secret |

Body:

```json
{ "id": "evt_001", "event": "payment.settled" }
```

Response on a valid delivery (`202`):

```json
{ "delivered": true, "id": "evt_001", "event": "payment.settled", "deliveredCount": 1 }
```

### `POST /webhook/rotate-secret`

Replaces the active secret with a freshly generated one. No body required.

Response (`200`):

```json
{ "rotated": true, "rotationCount": 1 }
```

### `POST /webhook/verify`

Verifies a payload and signature against the _currently_ active secret
only — a signature produced under a secret that was rotated out no longer
verifies, even if the payload itself is unchanged.

Body:

```json
{ "payload": { "id": "evt_001", "event": "payment.settled" }, "signature": "..." }
```

Response on a match (`200`):

```json
{ "verified": true, "id": "evt_001", "event": "payment.settled" }
```

Response on a mismatch (`401`):

```json
{ "verified": false, "error": "invalid_signature" }
```

### Errors common to all three endpoints

| Status | `error`              | Cause                                      |
| ------ | -------------------- | ------------------------------------------ |
| 400    | `invalid_payload`    | `id` or `event` missing or not a string    |
| 401    | `missing_signature`  | No signature provided                      |
| 401    | `invalid_signature`  | Signature does not match the active secret |
| 405    | `method_not_allowed` | Wrong HTTP method on a known path          |
| 404    | `not_found`          | Unknown path                               |

## Notes

`resetState()` is exported so a test can restore the initial secret and
clear delivery history. `currentSecret()` is exported for tests that need
to sign against a secret from before a rotation.
