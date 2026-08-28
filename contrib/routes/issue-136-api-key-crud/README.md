# Mock route suite: API key creation and listing (Issue #136)

Standalone mock route suite with two endpoints: one to create a mock API
key and one to list all keys created in the current process. Keys are
held in memory for the lifetime of the process — no chain, RPC, or
database access. The full key value is only ever returned once, at
creation time; the list endpoint always returns a masked version.

## Run

```sh
node route.mjs
# api-key-crud suite listening on http://localhost:4136
```

## Test

```sh
node route.test.mjs
```

## Endpoints

### `POST /api-keys`

Creates a new mock API key.

Body (optional):

```json
{ "label": "ci" }
```

Response (`201`):

```json
{
  "id": "key_0001",
  "label": "ci",
  "key": "vlr_ac91f...e8b2",
  "createdAt": "2026-08-25T00:00:00.000Z"
}
```

The `key` field is the full key value and is never returned again after
this response.

### `GET /api-keys`

Lists all keys created so far, with masked values only.

```json
{
  "keys": [
    {
      "id": "key_0001",
      "label": "ci",
      "maskedKey": "vlr_ac91****e8b2",
      "createdAt": "2026-08-25T00:00:00.000Z"
    }
  ]
}
```

Any other path returns `404` with `{ "error": "not_found" }`; a wrong
method on `/api-keys` returns `405` with `{ "error": "method_not_allowed" }`.

## Notes

`resetState()` is exported so a test can clear the in-memory key list.
