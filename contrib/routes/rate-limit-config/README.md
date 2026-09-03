# Rate Limit Configuration

## Purpose

This mock route simulates configuring rate limits for named endpoints using only
in-memory state. It is fully isolated inside
`contrib/routes/rate-limit-config/`.

## Endpoints

### `PUT /rate-limits`

Stores a custom rate limit for an endpoint.

Example request:

```json
{
  "endpointName": "listPolicies",
  "limit": 25
}
```

Example response (`200`):

```json
{
  "endpoint": "listPolicies",
  "limit": 25,
  "updatedAt": "2026-07-29T13:00:00.000Z"
}
```

### `GET /rate-limits/:endpointName`

<br />

Returns the current configuration for the endpoint. If the endpoint has not
been configured yet, the route returns a deterministic default limit of `100`.

Example default response (`200`):

```json
{
  "endpoint": "listPolicies",
  "limit": 100,
  "source": "default"
}
```

Example custom response (`200`):

```json
{
  "endpoint": "listPolicies",
  "limit": 25,
  "source": "custom",
  "updatedAt": "2026-07-29T13:00:00.000Z"
}
```

Example validation error (`400`):

```json
{
  "error": {
    "message": "limit must be a positive integer"
  }
}
```

## Validation Rules

- `endpointName` is required and must be a non-empty string.
- `limit` is required and must be a positive integer.
- `0`, negative numbers, decimals, and strings are rejected.

## How To Run The Test

```bash
node --test contrib/routes/rate-limit-config/route.test.js
```

## Expected Behavior

- Unknown endpoints return the deterministic default configuration.
- Configured endpoints return the last custom value stored in memory.
- Invalid payloads return descriptive `400` responses.

