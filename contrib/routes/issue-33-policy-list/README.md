# Mock route: policy list (Issue #33)

Standalone mock GET route returning a fixed array of sample account policy
summaries. No real chain or database access.

## Run

```sh
node route.mjs
# policy-list mock listening on http://localhost:4033/policies
```

## Test

```sh
node route.test.mjs
```

## Example

Request:

```
GET /policies
```

Response:

```json
[
  { "id": "pol_1001", "type": "spending-limit", "status": "active" },
  { "id": "pol_1002", "type": "spending-limit", "status": "paused" },
  { "id": "pol_1003", "type": "allowlist", "status": "active" },
  { "id": "pol_1004", "type": "time-lock", "status": "active" },
  { "id": "pol_1005", "type": "multi-sig", "status": "revoked" }
]
```
