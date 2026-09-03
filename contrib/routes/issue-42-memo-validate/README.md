# Mock route: memo validate (Issue #42)

Standalone mock POST route that accepts a memo string and validates its length
and type. Rejects memo text longer than 28 bytes and validates memo type
against allowed values: `text`, `id`, or `hash`.

## Run

```sh
node route.mjs
# memo-validate mock listening on http://localhost:4042/memo-validate
```

## Test

```sh
node route.test.mjs
```

## Example

Request:

```
POST /memo-validate
Content-Type: application/json

{ "memo": "hello", "type": "text" }
```

Response:

```json
{
  "valid": true,
  "memo": "hello",
  "type": "text"
}
```
