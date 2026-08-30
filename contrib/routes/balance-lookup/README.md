# Mock route: balance lookup (Issue #62)

Self-contained mock route module that returns balances for a single account or
for a batch of accounts in one request. Balances come from a fixed in-memory
fixture — no chain, RPC or database access — so it is for local UI/dev testing
only.

## Run

```sh
node route.mjs
# balance-lookup mock listening on http://localhost:4055
#   GET  /balances/:accountId
#   POST /balances/batch
```

Set `PORT` to use a different port.

## Test

```sh
node route.test.mjs
```

Covers the single lookup (hit and miss), the batch lookup (order preservation,
per-item misses, agreement with the single lookup), batch validation, and the
method/path guards.

## Endpoints

### `GET /balances/:accountId`

Returns every balance held by one account.

```sh
curl -s http://localhost:4055/balances/GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB
```

```json
{
  "accountId": "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB",
  "balances": [
    { "assetCode": "XLM", "balance": "1250.5000000" },
    { "assetCode": "USDC", "balance": "310.0000000" }
  ]
}
```

An unknown account is a `404` with `{"error":"account_not_found","accountId":"..."}`.

### `POST /balances/batch`

Resolves up to 50 accounts in one request. Results are returned in the same
order as the ids were sent, and an unknown account is a per-item miss rather
than a failure of the whole batch.

```sh
curl -s -X POST http://localhost:4055/balances/batch \
  -H 'Content-Type: application/json' \
  -d '{"accountIds":["GDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF","GZZZUNKNOWN"]}'
```

```json
{
  "results": [
    {
      "accountId": "GDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF",
      "found": true,
      "balances": [{ "assetCode": "XLM", "balance": "0.5000000" }]
    },
    { "accountId": "GZZZUNKNOWN", "found": false, "balances": [] }
  ],
  "requested": 2,
  "found": 1
}
```

## Errors

| Status | `error`                | Cause                                                |
| ------ | ---------------------- | ---------------------------------------------------- |
| 404    | `account_not_found`    | Single lookup for an id not in the fixture           |
| 400    | `account_ids_required` | Batch body had no `accountIds` array                 |
| 400    | `account_ids_empty`    | `accountIds` was an empty array                      |
| 400    | `batch_too_large`      | More than 50 ids (`maxBatchSize` is echoed back)     |
| 400    | `invalid_account_id`   | An entry was not a non-blank string                  |
| 400    | `invalid_body`         | Batch body was not a JSON object                     |
| 400    | `invalid_json`         | Batch body was not valid JSON                        |
| 405    | `method_not_allowed`   | Path matched but the method did not                  |
| 413    | `body_too_large`       | Body exceeded 64 KiB                                 |
| 404    | `not_found`            | Unknown path                                         |

## Fixture accounts

| Account id                                            | Balances               |
| ----------------------------------------------------- | ---------------------- |
| `GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB`  | XLM, USDC              |
| `GDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF` | XLM                    |
| `GHIJ1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF` | XLM, USDC, EURC        |
