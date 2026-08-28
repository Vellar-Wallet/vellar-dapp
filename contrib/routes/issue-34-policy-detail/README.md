# Mock route: policy detail (Issue #34)

Standalone mock GET route returning a single sample policy record looked up
by a path parameter id. No real chain or database access.

## Run

```sh
node route.mjs
# policy-detail mock listening on http://localhost:4034/policies/:id
```

## Test

```sh
node route.test.mjs
```

## Example

Request:

```
GET /policies/pol_1001
```

Response:

```json
{
  "id": "pol_1001",
  "type": "spending-limit",
  "status": "active",
  "limit": "500.0000000",
  "window": "daily"
}
```

An id that isn't in the sample dataset returns a 404-style payload:

```
GET /policies/pol_9999
```

```json
{
  "error": "not_found",
  "message": "No policy found for id \"pol_9999\""
}
```
