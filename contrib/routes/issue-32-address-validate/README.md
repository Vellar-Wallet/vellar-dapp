# Mock route: address validate (Issue #32)

Standalone mock POST route handler under `contrib/routes/` that accepts a POST body containing a Stellar address string and validates its format.

## Validation Rules

1. Must be a string.
2. Must start with character `G` (Stellar public key encoding prefix).
3. Must be exactly 56 characters long.

## Run

```sh
node route.mjs
# address-validate mock listening on http://localhost:4032/address-validate
```

## Example

### Valid Request:

```
POST /address-validate
Content-Type: application/json

{ "address": "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZLXF3WGC6W263L2B" }
```

Response:

```json
{
  "valid": true,
  "address": "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZLXF3WGC6W263L2B"
}
```

### Invalid Request:

```
POST /address-validate
Content-Type: application/json

{ "address": "INVALID_ADDRESS" }
```

Response:

```json
{
  "valid": false,
  "reason": "Public key address must start with 'G'",
  "address": "INVALID_ADDRESS"
}
```
