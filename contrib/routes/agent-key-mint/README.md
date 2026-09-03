# Agent Session Key Mint

## Purpose

This mock route simulates minting a scoped agent session key with deterministic
identifiers and timestamps. It does not perform cryptography or call any
external system.

## Endpoints

### `POST /session-keys/mint`

<br />

Creates a mock session key.

Example request:

```json
{
  "expirySeconds": 90,
  "budget": 250
}
```

Example response (`201`):

```json
{
  "keyId": "mock-session-key-0001",
  "expiresAt": "2026-07-29T14:31:30.000Z",
  "budget": 250,
  "createdAt": "2026-07-29T14:30:00.000Z"
}
```

Example validation error (`400`):

```json
{
  "error": {
    "message": "expirySeconds must be greater than 0"
  }
}
```

## Validation Rules

- `expirySeconds` is required and must be greater than `0`.
- `budget` is required and must be greater than `0`.

## How To Run The Test

```bash
node --test contrib/routes/agent-key-mint/route.test.js
```

## Expected Behavior

- Each successful request returns a deterministic mock key id.
- `expiresAt` is computed as `createdAt + expirySeconds`.
- Invalid payloads return descriptive `400` errors.

