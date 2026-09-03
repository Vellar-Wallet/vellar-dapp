# Wallet Recovery Route Suite (Issue #105)

A dependency-free Node.js mock for the wallet recovery flow. State is explicit and deterministic, so the handler can be tested without a database, network, or chain connection.

## Routes

| Method | Path | Description |
|--------|------|-------------|
| POST | `/request-recovery` | Creates a pending recovery request. Body: `{ "accountId": "account_001", "fallbackSigner": "fallback_001" }`. |
| POST | `/verify-fallback` | Verifies the fallback for one exact request. Body: `{ "recoveryRequestId": "recovery_001", "verificationToken": "verify_recovery_001" }`. |
| POST | `/issue-new-signer` | Issues a signer only after that same recovery request is verified. Body: `{ "recoveryRequestId": "recovery_001", "signer": "signer_001" }`. |

A request that has not been verified returns `403 recovery_not_verified`. A verification token belonging to another request returns `401 invalid_fallback_verification`, and cannot authorize signer issuance.

## Run the test

```sh
node route.test.mjs
```

## Run the mock server

```sh
node route.mjs
```

The server listens on `http://localhost:4125` by default. Set `PORT` to use another port.
