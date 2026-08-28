# Mock route: policy rollback suite (Issue #113)

Simulates deploying a new policy version, detecting a failure, and rolling back to the previous known good version.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/deploy` | Deploy a new policy version. Body: `{ "version": "v2.0.0", "fail": false }`. Set `fail: true` to simulate a failed deploy. |
| GET | `/deploy-status` | Returns the last deploy result and currently active version. |
| POST | `/rollback` | Rolls back to the previously active version. |

## Run

```sh
node route.mjs
# policy-rollback mock listening on http://localhost:4113
```

## Test

```sh
node route.test.mjs
```

## Example — successful deploy

```
POST /deploy
{ "version": "v2.0.0" }
```

```json
{ "deployed": true, "version": "v2.0.0", "activeVersion": "v2.0.0" }
```

## Example — failed deploy then rollback

```
POST /deploy
{ "version": "v3.0.0", "fail": true }
```

```json
{ "deployed": false, "reason": "simulated_failure", "activeVersion": "v2.0.0" }
```

```
POST /rollback
```

```json
{ "rolledBack": true, "activeVersion": "v2.0.0", "rolledTo": "v2.0.0" }
```
