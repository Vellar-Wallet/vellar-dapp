# Mock route: origin permission status (Issue #46)

Standalone mock GET route reporting whether a given dApp origin currently holds
an active permission grant. The origin is passed as a query parameter and
looked up against a fixed sample dataset — no chain or database access.

An unknown origin is not an error: the route answers `200` with
`granted: false`, so callers can treat "no grant" and "grant" with the same
response shape.

## Run

```sh
node route.mjs
# permission-status mock listening on http://localhost:4046/permission-status
```

## Test

```sh
node route.test.mjs
```

Covers a known origin, a known origin supplied with a path (normalization), an
unknown origin, a missing `origin` parameter, and a malformed one.

## Request

```
GET /permission-status?origin=https://app.example.com
```

The value is normalized to a bare origin (scheme + host + port) before lookup,
so `https://app.example.com/settings` resolves to the same record.

Sample dataset origins: `https://app.example.com`, `https://dapp.example.org`,
`http://localhost:3000`.

## Response

Known origin:

```json
{
  "origin": "https://app.example.com",
  "granted": true,
  "grantId": "grant_4f1c1a20",
  "scopes": ["accounts:read", "payments:sign"],
  "grantedAt": "2026-05-02T10:12:00.000Z"
}
```

Unknown origin:

```json
{
  "origin": "https://unknown.example.net",
  "granted": false,
  "scopes": [],
  "grantedAt": null
}
```

## Errors

| Status | Code              | When                                      |
| ------ | ----------------- | ----------------------------------------- |
| 400    | `origin_required` | `origin` query parameter missing or empty |
| 400    | `invalid_origin`  | `origin` is not a parseable http(s) URL   |

Any other method or path returns `404` with `{ "error": "not_found" }`.
