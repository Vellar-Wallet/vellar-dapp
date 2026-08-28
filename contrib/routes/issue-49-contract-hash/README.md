# Mock route: contract hash (Issue #49)

Standalone mock GET route returning a fixed sample wasm hash for a contract id
path parameter. The hash is always a 64 character lowercase hex string. No real
chain or database access.

## Run

```sh
node route.mjs
# contract-hash mock listening on http://localhost:4049/contracts/:contractId/hash
```

## Test

```sh
node route.test.mjs
```

## Example

Request:

```
GET /contracts/CA0000000000000000000000000000000000000000000000000001/hash
```

Response:

```json
{
  "contractId": "CA0000000000000000000000000000000000000000000000000001",
  "wasmHash": "3f786850e387550fdab836ed7e6dc881de23001b3f786850e387550fdab836ed",
  "network": "testnet"
}
```

A contract id that isn't in the sample dataset returns a 404-style payload:

```
GET /contracts/CAUNKNOWN/hash
```

```json
{
  "error": "not_found",
  "message": "No contract found for id \"CAUNKNOWN\""
}
```

## Sample dataset

| contractId                                               | network     |
| -------------------------------------------------------- | ----------- |
| `CA0000000000000000000000000000000000000000000000000001` | `testnet`   |
| `CA0000000000000000000000000000000000000000000000000002` | `testnet`   |
| `CA0000000000000000000000000000000000000000000000000003` | `futurenet` |
