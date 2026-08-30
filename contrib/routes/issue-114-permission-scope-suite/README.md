# Mock route: permission scope suite (Issue #114)

Simulates a dApp permission scope handshake: a dApp requests scopes, a user approves a subset, and scopes can be checked.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/request-scopes` | dApp requests permission scopes. Body: `{ "scopes": ["read", "write", "admin"] }` |
| POST | `/approve-scopes` | User approves a subset. Body: `{ "requestId": "req_1", "approvedScopes": ["read"] }` |
| GET | `/check-scope` | Check if a scope is approved. Query: `?requestId=req_1&scope=read` |

## Run

```sh
node route.mjs
# permission-scope mock listening on http://localhost:4114
```

## Test

```sh
node route.test.mjs
```

## Example — full flow

1. Request scopes:
```
POST /request-scopes
{ "scopes": ["read", "write", "admin"] }
```
→ `{ "requestId": "req_1", "requestedScopes": ["read", "write", "admin"] }`

2. Approve subset:
```
POST /approve-scopes
{ "requestId": "req_1", "approvedScopes": ["read", "write"] }
```
→ `{ "requestId": "req_1", "approved": ["read", "write"], "rejected": ["admin"] }`

3. Check scope:
```
GET /check-scope?requestId=req_1&scope=admin
```
→ `{ "scope": "admin", "approved": false }`
