# Webhook Retry Queue

## Purpose

This mock route simulates a webhook delivery queue that advances through a
deterministic retry lifecycle in memory. It does not send real webhooks or
touch any code outside `contrib/routes/webhook-retry-queue/`.

## Endpoints

### `POST /deliveries`

Creates a new webhook delivery entry.

Example request:

```json
{}
```

Example response (`201`):

```json
{
  "deliveryId": "delivery-0001",
  "status": "pending",
  "retryCount": 0,
  "createdAt": "2026-07-29T12:00:00.000Z"
}
```

### `GET /deliveries/:deliveryId`

Returns the current delivery status and automatically advances the lifecycle on
each lookup until a terminal state is reached.

Lifecycle progression:

`pending -> retrying (1) -> retrying (2) -> retrying (3) -> delivered`

Example response (`200`):

```json
{
  "deliveryId": "delivery-0001",
  "status": "retrying",
  "retryCount": 2,
  "maxRetries": 3,
  "updatedAt": "2026-07-29T12:00:02.000Z"
}
```

Example error (`404`):

```json
{
  "error": {
    "message": "delivery missing-delivery was not found"
  }
}
```

## Validation Rules

- `deliveryId` must be present in the path for status lookups.
- Unknown deliveries return `404`.
- Unsupported method/path combinations return `404`.

## How To Run The Test

<br />

```bash
node --test contrib/routes/webhook-retry-queue/route.test.js
```

## Expected Behavior

- Enqueue starts every delivery in `pending` with `retryCount: 0`.
- Status polling advances the delivery deterministically.
- Once the delivery reaches `delivered`, later lookups keep returning the same
  terminal state.

