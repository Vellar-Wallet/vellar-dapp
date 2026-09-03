# Mock route: payment request (Issue #27)

Standalone mock POST route that accepts a payment request payload and echoes
back a validation result. No real chain or database access.

## Run

```sh
node route.mjs
# payment-request mock listening on http://localhost:4027/payment-request
```

## Test

```sh
node route.test.mjs
```

## Example

### Success

Request:

```
POST /payment-request
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
  "valid": true,
  "recipient": "GABCD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGH",
  "amount": "25.0000000",
  "asset": "XLM"
}
```

### Error (missing field)

Request:

```
POST /payment-request
Content-Type: application/json

{
  "recipient": "GABCD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGH",
  "asset": "XLM"
}
```

Response (`400`):

```json
{
  "error": "invalid_request",
  "message": "Missing required field(s): amount",
  "missingFields": ["amount"]
}
```
