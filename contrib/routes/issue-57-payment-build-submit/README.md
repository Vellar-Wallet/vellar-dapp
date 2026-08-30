# Mock route: payment build + submit (Issue #57)

Standalone mock route module simulating a two-step payment flow: build a
draft from a payment payload, then submit that draft to get back a fake
transaction hash. No real chain or database access -- drafts are held in
an in-memory `Map` that resets whenever the process restarts.

## Run

```sh
node route.mjs
# payment-build-submit mock listening on http://localhost:4057/payment/build and /payment/submit/:draftId
```

## Test

```sh
node route.test.mjs
```

## Endpoints

### `POST /payment/build`

Validates `recipient`, `amount`, and `asset`, then returns a draft record
with a generated `draftId`.

Request:

```
POST /payment/build
Content-Type: application/json

{
  "recipient": "GABCD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGH",
  "amount": "25.0000000",
  "asset": "XLM"
}
```

Response (`200`):

```json
{
  "draftId": "draft_1a2b3c4d5e6f",
  "recipient": "GABCD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGH",
  "amount": "25.0000000",
  "asset": "XLM",
  "status": "built",
  "createdAt": "2026-07-28T10:00:00.000Z"
}
```

Response when a required field is missing (`400`):

```json
{
  "error": "invalid_request",
  "message": "Missing required field(s): amount",
  "missingFields": ["amount"]
}
```

### `POST /payment/submit/:draftId`

Submits a previously built draft and returns a fake transaction hash.

Response (`200`):

```json
{
  "draftId": "draft_1a2b3c4d5e6f",
  "status": "submitted",
  "txHash": "9f2c...  (64 hex chars)",
  "submittedAt": "2026-07-28T10:00:05.000Z"
}
```

Response for an unknown draft id (`404`):

```json
{
  "error": "draft_not_found",
  "message": "No draft found for draftId \"draft_does_not_exist\""
}
```

Response when the same draft is submitted twice (`409`, no double-spend):

```json
{
  "error": "already_submitted",
  "message": "Draft \"draft_1a2b3c4d5e6f\" has already been submitted",
  "txHash": "9f2c...  (same hash as the first submission)"
}
```
