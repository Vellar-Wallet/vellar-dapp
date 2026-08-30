# Mock route: trust settings suite (Issue #9 — B9)

Simulates the trust settings screen for verified-only signing. Exposes endpoints
to query the current policy attachment state, enforcement mode, and to trigger
the attach/revoke flows that the UI calls.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/trust/status` | Returns whether a verified-only policy is attached and the enforcement mode. |
| POST | `/trust/attach` | Simulates attaching a verified-only policy (requires `registryAddress` and optional `enforcementMode`). |
| POST | `/trust/revoke` | Simulates removing the verified-only policy (requires passkey authorization token). |
| GET | `/trust/descriptor` | Returns the honest enforcement description from the policy manifest. |

## Run

```sh
node route.mjs
# trust-settings mock listening on http://localhost:4009
```

## Test

```sh
node route.test.mjs
```

## Example — unattached state

```
GET /trust/status
```

```json
{ "attached": false, "mode": null }
```

## Example — attach

```
POST /trust/attach
{ "registryAddress": "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67", "enforcementMode": "strict" }
```

```json
{ "attached": true, "mode": "strict", "contractId": "CDEPLOYED..." }
```

## Example — revoke (owner only)

```
POST /trust/revoke
{ "authToken": "passkey-sig-valid" }
```

```json
{ "removed": true }
```
