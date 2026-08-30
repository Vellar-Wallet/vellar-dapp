# Mock route suite: verification diff between builds (Issue #121)

Standalone mock route suite that compares two sample build results for the
same contract and reports which fields differ. No chain, RPC, or database
access — every build record is fixed sample data.

## Run

```sh
node route.mjs
# build-diff suite listening on http://localhost:4121
```

## Test

```sh
node route.test.mjs
```

## Endpoints

### `GET /build-diff/builds`

Lists the sample build records and the field names the compare endpoint
inspects.

Response (abridged):

```json
{
  "builds": [
    {
      "id": "build_001",
      "contract": "vellar_verified_registry",
      "builtAt": "2026-07-26T09:15:00.000Z",
      "wasmHash": "9f2c41ab...d7a2",
      "size": 41728,
      "compiler": "soroban-cli 21.5.0",
      "optimized": true
    }
  ],
  "count": 4,
  "comparedFields": ["wasmHash", "size", "compiler", "optimized"]
}
```

Sample data is arranged so both outcomes are reachable: `build_001` and
`build_003` are byte identical reproductions, `build_002` differs in hash,
size, and optimization, and `build_004` differs only in hash and compiler.

### `GET /build-diff/compare`

Compares two builds by id.

| Query | Required | Description |
| --- | --- | --- |
| `a` | yes | First build id |
| `b` | yes | Second build id |

Request:

```
GET /build-diff/compare?a=build_001&b=build_002
```

Response:

```json
{
  "a": "build_001",
  "b": "build_002",
  "contract": "vellar_verified_registry",
  "identical": false,
  "differingFields": ["wasmHash", "size", "optimized"],
  "differences": [
    { "field": "wasmHash", "a": "9f2c41ab...d7a2", "b": "3d81ff05...0f74" },
    { "field": "size", "a": 41728, "b": 43904 },
    { "field": "optimized", "a": true, "b": false }
  ]
}
```

For identical builds, `identical` is `true` and both `differingFields` and
`differences` are empty.

Errors:

| Status | `error` | Cause |
| --- | --- | --- |
| 400 | `missing_build_id` | `a` or `b` not supplied |
| 404 | `build_not_found` | An id does not match a sample build |

Any other path returns `404` with `{ "error": "not_found" }`; any method
other than `GET` returns `405` with `{ "error": "method_not_allowed" }`.

## Notes

The folder is named `issue-121-build-diff-suite` to follow the
`contrib/routes/issue-<n>-<name>/` convention used by the sibling route
folders; the suite itself is the `build-diff-suite` described in the issue.
