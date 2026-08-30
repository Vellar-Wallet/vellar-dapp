# Mock route: multisig config (Issue #128)

Standalone mock GET route handler that returns a fixed sample multisig
threshold and signer set for an account.

## Rules

- Query param `account` selects the sample account.
- Response: `{ account, threshold, signers: [{ key, type, weight }] }`.
- Includes 2 sample accounts with differing thresholds and signer counts.
- Unknown accounts respond `404` with `{ error: "account_not_found" }`.

## Run

```sh
node route.mjs
```

## Example

```
GET /multisig-config?account=GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZLXF3WGC6W263L2B
```

## Testing

Verifies the response shape and the two differing sample accounts:

```sh
node route.test.mjs
```
