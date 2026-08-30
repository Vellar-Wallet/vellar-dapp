# Mock routes: contract upgrade compatibility checks (Issue #107)

Standalone mock route suite that simulates comparing a proposed new contract
wasm against the currently deployed one and reporting whether the upgrade is
compatible.

Nothing touches a real chain, database, or wasm binary. `WASM_CATALOG` and
`DEPLOYED_CONTRACTS` in [route.mjs](route.mjs) are a fixed sample dataset
standing in for a wasm inspector and a deployment registry.

## Run

```sh
node route.mjs
# upgrade-compatibility mock listening on http://localhost:4107
#   GET  /upgrade/current-version?contractId=escrow-main
#   POST /upgrade/check-upgrade
```

## Test

```sh
node route.test.mjs
```

## Endpoints

### `GET /upgrade/current-version?contractId=<id>`

Returns the wasm hash currently deployed for a contract, plus its metadata.

```json
{
  "contractId": "escrow-main",
  "hash": "wasm_escrow_v1",
  "storageVersion": 2,
  "functions": [
    { "name": "deposit", "params": ["from", "amount"] },
    { "name": "release", "params": ["to"] },
    { "name": "refund", "params": ["to"] }
  ]
}
```

`400` if `contractId` is missing, `404` if it is not registered.

### `POST /upgrade/check-upgrade`

Request:

```json
{ "contractId": "escrow-main", "proposedHash": "wasm_escrow_v2_broken" }
```

Response:

```json
{
  "contractId": "escrow-main",
  "currentHash": "wasm_escrow_v1",
  "proposedHash": "wasm_escrow_v2_broken",
  "compatible": false,
  "concerns": [
    "storage schema version would downgrade from 2 to 1",
    "function 'release' would be removed"
  ]
}
```

`400` if `contractId` or `proposedHash` is missing. `404` if either does not
resolve to a known contract or wasm hash.

## Compatibility rules

A proposed wasm is compared against the currently deployed one on two axes,
and every violation is reported (not just the first):

1. **Storage schema version must not decrease.** A lower `storageVersion` on
   the proposed wasm than the currently deployed one is a concern — existing
   persisted state may no longer be readable.
2. **Every function the current wasm exports must still exist with the same
   parameter count.** A removed function, or one whose parameter list length
   changed, is a concern. Adding new functions, or bumping the storage
   version upward, is never a concern.

`compatible` is `true` exactly when `concerns` is empty.

## Sample dataset

| Contract      | Deployed hash    |
| ------------- | ---------------- |
| `escrow-main` | `wasm_escrow_v1` |
| `vault-main`  | `wasm_vault_v1`  |

| Proposed hash               | vs. `wasm_escrow_v1`                            | Result       |
| --------------------------- | ----------------------------------------------- | ------------ |
| `wasm_escrow_v2_compatible` | same storage version, adds an `extend` function | compatible   |
| `wasm_escrow_v2_broken`     | storage version 2 → 1, drops `release`          | incompatible |

See [route.test.mjs](route.test.mjs) for both cases exercised end to end.
