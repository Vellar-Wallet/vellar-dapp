# Mock route: verified-only signing E2E suite (Issue #12 — B12)

End-to-end mock route proving that a wallet with verified-only signing attached
rejects an interaction with an unverified contract and permits one with a
verified contract. Covers the recovery path from B11 at the UI level.

This route combines the verification check (B4/B10), the recovery path (B11),
and the trust settings (B9) into a single mock service that an e2e test can
drive against. It follows the existing mocked pattern: no backend, no secrets,
no funded account required.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/policy/status` | Returns whether verified-only signing is attached and mode. |
| POST | `/policy/attach` | Attaches the verified-only policy (mock deploy + attach). |
| POST | `/policy/remove` | Removes the policy (requires passkey auth). |
| POST | `/transaction/check` | Given a target contract, checks if the transaction is allowed. |
| GET | `/verification/:contractId` | Returns the verification status of a contract. |
| GET | `/explainer/blocked` | Returns the honest blocked-transaction explainer copy. |
| GET | `/recovery/threat-model` | Returns the documented threat model. |

## Run

```sh
node route.mjs
# verified-only e2e mock listening on http://localhost:4012
```

## Test

```sh
node route.test.mjs
```

## E2E scenario covered

1. **Blocked path**: Policy attached, target contract unverified → transaction
   rejected, explainer shown, user sees why and what to do next.
2. **Allowed path**: Policy attached, target contract verified → transaction
   proceeds to signing.
3. **Recovery path (B11)**: Owner removes the policy with passkey auth →
   policy removed, transactions no longer checked.
4. **Unauthorized recovery**: Session attacker cannot remove the policy.
