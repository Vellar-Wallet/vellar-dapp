# Mock route: recovery path suite (Issue #11 — B11)

Simulates the verified-only signing override and recovery path. Exposes endpoints
to remove or relax the verified-only policy, verifying that the owner can always
remove it (the policy cannot block its own removal), and that an unauthorized
caller cannot.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/recovery/status` | Returns whether a verified-only policy is attached and the recovery options. |
| POST | `/recovery/remove` | Removes the verified-only policy. Requires passkey auth token from the account owner. |
| POST | `/recovery/relax` | Relaxes from `strict` to `trusted_publishers` mode. Requires passkey auth token. |
| GET | `/recovery/threat-model` | Returns the documented threat model for session vs passkey control. |

## Run

```sh
node route.mjs
# recovery-path mock listening on http://localhost:4011
```

## Test

```sh
node route.test.mjs
```

## Example — remove policy

```
POST /recovery/remove
{ "authToken": "passkey-sig-valid" }
```

```json
{ "removed": true }
```

## Example — unauthorized removal rejected

```
POST /recovery/remove
{ "authToken": "wrong-token" }
```

```json
{ "removed": false, "error": "passkey authorization required" }
```
