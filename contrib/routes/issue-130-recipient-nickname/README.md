# Mock route: recipient nickname (Issue #130)

Standalone mock POST route handler that accepts a friendly nickname mapped to
a Stellar address and echoes back a confirmation.

## Rules

- `nickname` and `address` are both required.
- `address` must look like a well formed Stellar public key: a 56 character
  string starting with `G`.
- On success, responds `201` with `{ confirmed, nickname, address }`.
- On a missing field or malformed address, responds `400` with an `error` code.

## Run

```sh
node route.mjs
```

## Example

```
POST /recipient-nickname
{ "nickname": "mom", "address": "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZLXF3WGC6W263L2B" }
```

## Testing

Covers the success case and a malformed address case:

```sh
node route.test.mjs
```
