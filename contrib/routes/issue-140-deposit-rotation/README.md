# Mock route: deposit address rotation (Issue #140)

Standalone mock route module simulating a deposit address rotation flow:
get the current deposit address for an account, and rotate it to a newly
generated one. State is kept in-memory (seeded with one sample account) and
resets whenever the process restarts. No real chain or database access.

## Run

```sh
node route.mjs
# deposit-rotation mock listening on http://localhost:4140/deposit-address/:accountId{,/rotate}
```

## Test

```sh
node route.test.mjs
```

## Endpoints

### `GET /deposit-address/:accountId`

Returns the account's current deposit address. An account with no prior
address gets one minted lazily on first lookup.

Response (`200`):

```json
{ "accountId": "acct_demo", "address": "GA000..." }
```

### `POST /deposit-address/:accountId/rotate`

Rotates the account's deposit address to a newly generated one, guaranteed
distinct from the previous address.

Response (`200`):

```json
{ "accountId": "acct_demo", "address": "GD9F1C...", "previousAddress": "GA000..." }
```

A missing account id returns `400 account_id_required` from either
endpoint.

`route.test.mjs` covers get, rotate, then get again to confirm the address
changed and stuck, across two rotation cycles.
