# Policy Attach Transaction Builder

## Purpose

This mock route simulates building an unsigned transaction payload for attaching
a policy. The response is placeholder data only and never touches real wallet,
blockchain, or policy infrastructure.

## Endpoints

### `POST /policy-attachments/build`

Builds a deterministic fake unsigned transaction envelope.

Example request:

```json
{
  "policyId": "policy-123",
  "accountId": "account-789"
}
```

Example response (`200`):

```json
{
  "unsignedEnvelope": "unsigned-policy-policy-123-account-789-1785339900000",
  "expiry": "2026-07-29T15:50:00.000Z",
  "policyId": "policy-123",
  "accountId": "account-789"
}
```

Example validation error (`400`):

```json
{
  "error": {
    "message": "policyId is required"
  }
}
```

## Validation Rules

- `policyId` is required and must be a non-empty string.
- `accountId` is required and must be a non-empty string.

## How To Run The Test

```bash
node --test contrib/routes/policy-attach-build/route.test.js
```

## Expected Behavior

- The route returns a deterministic fake envelope string.
- The response always includes `expiry`, `policyId`, and `accountId`.
- Invalid payloads return descriptive `400` responses.

  <br />

