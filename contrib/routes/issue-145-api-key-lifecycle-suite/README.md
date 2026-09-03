# Mock route suite: API key lifecycle (Issue #145)

Self contained set of route handlers simulating an API key lifecycle with
scoped permissions: create, check-scope, and revoke.

## Endpoints

- `POST /api-keys`
  - Body: `{ "scopes": string[] }`
  - Creates a key with the given scopes (deduplicated) and returns
    `{ keyId, scopes, revoked }`.
  - Missing or invalid `scopes` responds `400`.
- `GET /api-keys/:keyId/check-scope?scope=<scope>`
  - Returns `{ allowed, reason }`.
  - `allowed` is `false` with `reason: "scope_not_permitted"` for a scope not
    included at creation time.
  - `allowed` is `false` with `reason: "revoked"` for any scope once the key
    has been revoked.
  - Unknown `keyId` responds `404`.
- `POST /api-keys/:keyId/revoke`
  - Marks the key revoked and returns `{ keyId, revoked: true }`.
  - Unknown `keyId` responds `404`.

## Run

```sh
node route.mjs
```

## Testing

Covers an allowed scope, a disallowed scope, and the post revoke rejection:

```sh
node route.test.mjs
```
