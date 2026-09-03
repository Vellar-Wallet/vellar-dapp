# Route suite: template versioning migration (Issue #123)

Self-contained route handlers that list versions of a policy template and
migrate an account using an older version to the current one, preserving
compatible fields.

## Endpoints

### GET /versions

Lists all available template versions and the current version.

```json
{
  "versions": ["1.0", "1.1", "2.0"],
  "current": "2.0"
}
```

### GET /current-config

Returns the current template version and its field names.

```json
{
  "version": "2.0",
  "fields": ["policyName", "maxSigners", "network", "expiry"]
}
```

### POST /migrate

Migrates a config from an older version to the current version by mapping
old field names to new ones.

Request (old version):
```json
{
  "version": "1.0",
  "name": "My Policy",
  "signerLimit": 3,
  "chain": "testnet"
}
```

Response:
```json
{
  "migrated": true,
  "config": {
    "version": "2.0",
    "policyName": "My Policy",
    "maxSigners": 3,
    "network": "testnet"
  }
}
```

Request (already current):
```json
{ "version": "2.0", "policyName": "X", "maxSigners": 1, "network": "mainnet" }
```

Response:
```json
{ "migrated": false, "config": {...}, "reason": "already_current" }
```

## Field migration map

| Old version | Old field     | New field    |
|-------------|---------------|--------------|
| 1.0         | name          | policyName   |
| 1.0         | signerLimit   | maxSigners   |
| 1.0         | chain         | network      |
| 1.1         | (no changes)  | —            |

## Run

```sh
node route.mjs
# template-versioning-suite mock listening on http://localhost:4052
```

## Test

```sh
node route.test.mjs
```
