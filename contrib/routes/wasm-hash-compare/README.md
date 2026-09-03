# WASM Hash Compare

A self-contained route module to look up a sample contract WASM hash and to compare two hashes for equality.

## Endpoints

- `GET /lookup/:contractId`
  - Returns the hash for a contract ID. Returns a 404 payload for unknown IDs.
- `POST /compare`
  - Body: `{ "hash1": "...", "hash2": "..." }`
  - Accepts two hash strings and returns a match boolean.

## Usage

```sh
node index.js
```

## Testing

Run the test script covering known/unknown lookups and matching/non-matching comparisons:

```sh
node test.js
```
