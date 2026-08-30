# Mock route: policy creation (Issue #35)

Standalone mock POST route that accepts a policy creation payload, validates it,
and echoes back the created record with a generated id.

This is a **mock**. Nothing is persisted, no chain or database is touched, and the
generated ids come from an in-memory counter that resets when the process restarts.

## Run

```sh
node route.mjs
# policy-create mock listening on http://localhost:4035/policies
```

## Test

```sh
node route.test.mjs
```

## Request

```
POST /policies
Content-Type: application/json
```

| Field           | Required | Notes                                            |
| --------------- | -------- | ------------------------------------------------ |
| `limit`         | yes      | Positive JSON number                             |
| `windowSeconds` | yes      | Positive JSON number                             |
| `type`          | no       | One of `spending-limit`, `allowlist`, `velocity` |
| `label`         | no       | Free-form string, defaults to `null`             |

Numeric strings such as `"500"` are rejected — send real JSON numbers.

## Example

Request:

```json
{
  "limit": 500,
  "windowSeconds": 86400,
  "type": "spending-limit",
  "label": "daily cap"
}
```

Response `201`:

```json
{
  "id": "pol_0001",
  "type": "spending-limit",
  "label": "daily cap",
  "limit": 500,
  "windowSeconds": 86400,
  "status": "active",
  "createdAt": "2026-07-28T12:00:00.000Z"
}
```

## Validation errors

All validation failures return `400` with an `error` code and a human-readable
`message`:

| `error`                  | Cause                                       |
| ------------------------ | ------------------------------------------- |
| `invalid_body`           | Body missing, or not a JSON object          |
| `limit_required`         | `limit` absent or `null`                    |
| `limit_invalid`          | `limit` not a number, or not greater than 0 |
| `windowSeconds_required` | `windowSeconds` absent or `null`            |
| `windowSeconds_invalid`  | `windowSeconds` not a number, or not > 0    |
| `invalid_type`           | `type` supplied but not a recognised value  |
| `invalid_json`           | Request body was not parseable JSON         |

Example `400`:

```json
{
  "error": "limit_invalid",
  "message": "\"limit\" must be greater than 0, received 0"
}
```
