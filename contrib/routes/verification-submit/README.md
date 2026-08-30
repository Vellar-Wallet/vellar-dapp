# Mock route: verification submit (Issue #50)

Standalone mock `POST` route that accepts a contract verification submission
and returns a generated verification job id. Nothing is persisted and no chain
or database is touched — the job id comes from an in-process counter, so it is
for local UI/dev testing only.

## Run

```sh
node route.mjs
# verification-submit mock listening on http://localhost:4054/verification/submit
```

Set `PORT` to use a different port.

## Test

```sh
node route.test.mjs
```

## Endpoint

### `POST /verification/submit`

Body fields:

| Field        | Type   | Required | Notes                            |
| ------------ | ------ | -------- | -------------------------------- |
| `contractId` | string | yes      | Must be present and non-blank.   |

Success (`202 Accepted`):

```json
{
  "jobId": "vjob_000001",
  "contractId": "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K",
  "status": "queued"
}
```

Job ids are sequential (`vjob_000001`, `vjob_000002`, ...) so responses are
reproducible across a run.

### Errors

| Status | `error`                | Cause                                        |
| ------ | ---------------------- | -------------------------------------------- |
| 400    | `contract_id_required` | No `contractId` field in the body            |
| 400    | `invalid_contract_id`  | `contractId` is not a string, or is blank    |
| 400    | `invalid_body`         | Body is not a JSON object                    |
| 400    | `invalid_json`         | Body is not valid JSON                       |
| 405    | `method_not_allowed`   | Path matched but the method was not `POST`   |
| 413    | `body_too_large`       | Body exceeded 64 KiB                         |
| 404    | `not_found`            | Unknown path                                 |

## Example

```sh
curl -s -X POST http://localhost:4054/verification/submit \
  -H 'Content-Type: application/json' \
  -d '{"contractId":"CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K"}'
```

```sh
curl -s -X POST http://localhost:4054/verification/submit \
  -H 'Content-Type: application/json' -d '{}'
# {"error":"contract_id_required"}
```
