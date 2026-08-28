# Mock route: transfer list suite (Issue #104)

Simulates per-account allowlist and denylist checks for proposed payment recipient transfers.

## Features & Rules
- Allowlists and denylists are maintained per sending account.
- **Denylist Precedence**: A denylisted recipient is **always rejected**, even if also present on the allowlist.
- **Clear Failure Reason**: `/check-transfer` returns `allowed: false` along with a human-readable `reason` field when a transfer is rejected.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/add-to-list` | Add a recipient to account's `allowlist` or `denylist`. |
| POST | `/remove-from-list` | Remove a recipient from account's `allowlist` or `denylist`. |
| POST / GET | `/check-transfer` | Check if proposed transfer from account to recipient is allowed. |

## Endpoints Detail

### 1. `POST /add-to-list`
Request body:
```json
{
  "account": "GBXACCOUNT11111111111111111111111111111111111111111111",
  "listType": "allowlist", // or "denylist"
  "recipient": "GCXRECIPIENT222222222222222222222222222222222222222"
}
```
Response:
```json
{
  "success": true,
  "account": "GBXACCOUNT11111111111111111111111111111111111111111111",
  "listType": "allowlist",
  "recipient": "GCXRECIPIENT222222222222222222222222222222222222222",
  "message": "Successfully added GCXRECIPIENT222222222222222222222222222222222222222 to allowlist for account GBXACCOUNT11111111111111111111111111111111111111111111"
}
```

### 2. `POST /remove-from-list`
Request body:
```json
{
  "account": "GBXACCOUNT11111111111111111111111111111111111111111111",
  "listType": "denylist",
  "recipient": "GCXRECIPIENT333333333333333333333333333333333333333"
}
```

### 3. `POST /check-transfer`
Request body:
```json
{
  "account": "GBXACCOUNT11111111111111111111111111111111111111111111",
  "recipient": "GCXRECIPIENT222222222222222222222222222222222222222",
  "amount": "100"
}
```
Allowed response:
```json
{
  "allowed": true,
  "account": "GBXACCOUNT11111111111111111111111111111111111111111111",
  "recipient": "GCXRECIPIENT222222222222222222222222222222222222222",
  "amount": "100",
  "reason": null
}
```
Denied response:
```json
{
  "allowed": false,
  "account": "GBXACCOUNT11111111111111111111111111111111111111111111",
  "recipient": "GCXRECIPIENT333333333333333333333333333333333333333",
  "amount": "50",
  "reason": "Recipient is on the denylist (denylist takes precedence over allowlist)"
}
```

## Running & Testing

### Start server:
```sh
node route.mjs
# transfer-list-suite route server listening on http://localhost:4104
```

### Execute test suite:
```sh
node route.test.mjs
```
