# Mock route: permission grant (Issue #45)

Standalone mock POST route that accepts a body granting a dApp origin
permission and echoes back a confirmation record.

The handler validates that `origin` is present and parses as an `http(s)` URL,
normalizes it down to a bare origin (scheme + host + port), and returns a
granted record containing the origin, the granted scopes, a grant id, and a
`grantedAt` timestamp. Nothing is persisted — this is a fixture for wiring UI
against while the real permission service is being built.

## Run

```sh
node route.mjs
# permission-grant mock listening on http://localhost:4145/permission-grant
```

The port is 4145 rather than 4045: 4045 is on the WHATWG blocked-port list, so
browsers and `fetch()` refuse to connect to it. Override with `PORT` if needed.

## Test

```sh
node route.test.mjs
```

Covers the success case (including scope deduplication and origin
normalization) and the failure cases: missing origin, absent body, a
non-URL origin, a non-`http(s)` scheme, a non-string origin, and an unknown
scope.

## Request

```
POST /permission-grant
Content-Type: application/json

{
  "origin": "https://app.example.com/dashboard",
  "scopes": ["accounts:read", "payments:sign"]
}
```

`scopes` is optional and defaults to `["accounts:read"]`. Valid scopes are
`accounts:read`, `payments:sign`, and `policies:read`.

## Response

`201 Created`:

```json
{
  "granted": true,
  "grantId": "grant_2f0a1c5e-9c1c-4a4a-8f1a-4a6f1f4b9d21",
  "origin": "https://app.example.com",
  "scopes": ["accounts:read", "payments:sign"],
  "grantedAt": "2026-07-29T12:00:00.000Z"
}
```

## Errors

All errors return `400` with an `error` code:

| Code                             | When                                         |
| -------------------------------- | -------------------------------------------- |
| `origin_required`                | `origin` missing or empty (or no body)       |
| `origin_must_be_string`          | `origin` is not a string                     |
| `invalid_origin`                 | `origin` is not a parseable `http(s)` URL    |
| `scopes_must_be_non_empty_array` | `scopes` given but not a non-empty array     |
| `invalid_scope`                  | `scopes` contains an unsupported value       |
| `invalid_json`                   | request body is not valid JSON (server only) |

Any other method or path returns `404` with `{ "error": "not_found" }`.
