# Mock route: sample deposit address (Issue #131)

Standalone mock route module returning a fixed sample deposit address and
memo for a given account id path parameter. In-memory sample dataset only,
no chain or database access.

## Run

```sh
node route.mjs
# deposit-address mock listening on http://localhost:4131/deposit-address/{accountId}
```

## Test

```sh
node route.test.mjs
```

## Endpoints

### `GET /deposit-address/:accountId`

Response on a hit (`200`):

```json
{ "accountId": "acct_001", "address": "GA111DEPOSIT...", "memo": "100231" }
```

Response when the account id is not in the sample dataset (`404`):

```json
{ "error": "not_found", "message": "no deposit address for account acct_999" }
```

Sample dataset contains `acct_001` and `acct_002`.
