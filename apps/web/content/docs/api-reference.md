# API Reference

All endpoints are reached through the **API gateway** (`http://localhost:4000`
in local dev). The gateway proxies by prefix to the owning service; you never
call a service directly from a browser.

Request and response bodies are JSON. Validation failures return `400` with
`{ "error": "invalid_body", "details": [...] }`.

> **No server-side signing.** There is no endpoint that signs a transaction.
> Signing is always client-side (WebAuthn / device key); the API only submits
> already-signed transactions. This is a deliberate no-key-custody design.

---

## Health

Every service exposes:

```
GET /health  →  200  { "status": "ok", "service": "<name>" }
```

---

## Wallet API (`/wallet/*` → wallet-service)

### `POST /wallet/create`

Records a newly-created smart wallet and submits its deployment transaction.

```jsonc
// request
{
  "keyId": "<base64url WebAuthn credential id>",
  "contractId": "C...",            // the smart-account address
  "network": "testnet",            // or "mainnet"
  "signedTx": "<signed XDR>"
}
// 201
{ "contractId": "C...", "sessionId": "...", "txHash": "..." }
```

Errors: `409 wallet_exists` (keyId already mapped on that network),
`502` (relayer/submission failure).

### `POST /wallet/connect`

Resolves the smart-account for a known passkey and opens a session record
(reconnect flow).

```jsonc
// request
{ "keyId": "<base64url credential id>", "network": "testnet" }
// 200
{ "contractId": "C...", "sessionId": "..." }
```

Errors: `404 wallet_not_found`.

### `POST /wallet/submit`

Submits an already-signed transaction (payments, signer changes, policy
attach). Returns once the network accepts it.

```jsonc
// request
{ "signedXdr": "<signed XDR>", "network": "testnet" }
// 200
{ "hash": "..." }
```

Errors: `502` (submission failure — includes relayer-not-configured).

### `GET /wallet/session/:id`

Returns a single session record, or `404 session_not_found`.

### `GET /wallet/sessions?contractId=C...&network=testnet`

Lists active sessions for an account, most-recently-active first (device
management).

```jsonc
// 200
{ "sessions": [ { "id": "...", "contractId": "C...", "network": "testnet", "createdAt": "...", "lastActiveAt": "..." } ] }
```

### `DELETE /wallet/session/:id`

Revokes a session. `204` on success, `404 session_not_found` otherwise.

---

## Lifecycle API (`/lifecycle/*` → lifecycle-service)

Operates on **classic (G-address) accounts** — the accounts a user wants to
clean up and merge into their smart wallet. Contract addresses are rejected.

### `POST /lifecycle/inspect`

```jsonc
// request
{ "accountId": "G..." }
// 200
{ "account": { "accountId": "G...", "sequence": "...", "balances": [...], "dataKeys": [...], "offers": [...], "openOffers": 0 } }
```

Errors: `422 not_classic_account`.

### `POST /lifecycle/plan`

Produces a cleanup plan: trustline / balance / offer / data-entry blockers,
each with an explicit action, plus `estimatedTransactions` and `mergeReady`.

```jsonc
// request
{ "accountId": "G...", "destination": "G..." }
```

Errors: `422 not_classic_account`, `invalid_destination` (non-classic, or same
as source).

### `POST /lifecycle/execute`

Builds the **unsigned** cleanup transactions (dependency-ordered: payments →
trustline removals → offer cancels → data deletions), each with a precomputed
watchable hash. VELA holds no classic keys, so the user signs these in whatever
wallet controls the account.

### `POST /lifecycle/merge`

Re-inspects and refuses (`409`) until the account is `mergeReady`, then builds
the `accountMerge` transaction (unsigned).

---

## Policy API (`/policies/*` → policy-service)

### `GET /policies/templates`

Lists the available policy templates and how each is enforced on-chain.

```jsonc
// 200
[ { "type": "spending_limit", "title": "Spending limit", "description": "...", "enforcement": { "kind": "policy-contract", "wasmHash": "..." } }, ... ]
```

### `POST /policies/validate`

Validates a policy definition against its template schema.

```jsonc
// request: a policy definition
// 200
{ "valid": true, "errors": [] }
```

### `POST /policies/generate`

Validates and generates a policy record: the definition, a deterministic
content hash, and a deployment manifest (including the on-chain constructor
args for spending limits).

```jsonc
// request
{ "definition": { "version": "1", "type": "spending_limit", "owners": ["C..."], "spendingLimits": { "dailyXlm": "10" } }, "network": "testnet" }
// 201
{ "policy": { "id": "...", "status": "generated", "definition": {...}, "policyHash": "...", "manifest": {...} } }
```

Errors: `422 invalid_policy` (with an `errors` array).

### `POST /policies/:id/simulate`

Dry-runs the on-chain instance deploy for a wallet (build + simulate, no
submit) so the UI can confirm success and cost before the user is asked to sign.

```jsonc
// request
{ "wallet": "C..." }
// 200
{ "ok": true, "minResourceFee": "..." }   // or { "ok": false, "error": "..." }
```

### `POST /policies/:id/deploy-instance`

Deploys the per-user policy contract instance (sponsor-funded, server-side),
bound to the caller's smart account. Returns the deployed contract id, which
the client then attaches with a passkey-signed `kit.addPolicy`.

```jsonc
// request
{ "wallet": "C..." }
// 200
{ "policy": { ..., "status": "instance_deployed", "instance": { "contractId": "C...", "txHash": "..." } }, "contractId": "C..." }
```

Errors: `503` (no sponsor configured), `404 policy_not_found`,
`422 not_deployable`, `502 deploy_failed`.

### `POST /policies/deploy`

Records a completed attach (the `kit.addPolicy` transaction is built and
passkey-signed client-side).

```jsonc
// request
{ "policyId": "...", "txHash": "...", "contractId": "C..." }
// 200
{ "policy": { ..., "status": "deployed", "deployment": {...} } }
```

### `GET /policies/:id`

Returns a policy record, or `404 policy_not_found`.
