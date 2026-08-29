# Issue 7 — Verified-Only Policy Template (B7 / B8)

SDK route module and template definitions for the verified-only policy. Provides the typed policy surface that third-party developers use through the wallet policies API.

## Requirements covered

- **B7**: Template definition, validation, and generation for the verified-only policy.
- **B8**: SDK types, list/generate/simulate/deploy functions, and documentation.

## Exports

| Export | Description |
|---|---|
| `VERIFIED_ONLY_TEMPLATE` | Template metadata (type, title, description, parameters, enforcement). |
| `VERIFIED_ONLY_POLICY_WASM_HASH` | Canonical wasm hash of the deployed verified-only policy contract. |
| `validateVerifiedOnlyDefinition(def)` | Validates a policy definition against the template schema. |
| `generateVerifiedOnlyPolicy(def, network?)` | Generates a policy record with manifest and constructor args. |
| `simulateVerifiedOnlyPolicy(generated)` | Dry-run deploy simulation — returns validity and estimated cost. |
| `deployVerifiedOnlyPolicy(generated, walletAddress)` | Returns orchestration steps and confirms wallet signature is required. |
| `listVerifiedOnlyTemplate()` | Returns the template for listing in a policy builder UI. |
| `handleRequest(req)` | HTTP route handler (GET = list, POST = validate + generate). |

## Enforcement modes

| Mode | On-chain behaviour |
|---|---|
| `strict` | Authorize only when the target contract's wasm hash is in the verified registry. |
| `trusted_publishers` | Authorize when verified and attested by a trusted publisher. |

**Note**: `warn` mode is not implemented on-chain. A policy contract can only authorize or reject — it cannot express a warning. Warn behaviour belongs in the client layer (B10).

## Tests

```sh
node contrib/routes/issue-7-verified-only-policy/route.test.mjs
```
