# Mock route: account status (Issue #28)

Standalone mock GET route returning a fixed account status payload for a
given account id path parameter. No real chain or database access.

## Run

```sh
node route.mjs
# account-status mock listening on http://localhost:4028/account-status/:accountId
```

## Test

```sh
node route.test.mjs
```

## Example

Request:

```
GET /account-status/GABCD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGH
```

Response:

```json
{
  "accountId": "GABCD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGH",
  "exists": true,
  "funded": true,
  "sequence": "123456789012345"
}
```
