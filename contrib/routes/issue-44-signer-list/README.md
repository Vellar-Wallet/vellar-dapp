# Mock route: signer list (Issue #44)

Standalone mock GET route returning a fixed array of sample signer entries for
a smart account. Each entry carries a `keyType` (`ed25519` or `secp256r1`) and a
`weight`, alongside a stable id, label, public key, and creation timestamp.

No chain, network, or database access — the data is a hard-coded fixture, so
the route is safe to point a UI at while the real signer service is being
built.

## Run

```sh
node route.mjs
# signer-list mock listening on http://localhost:4044/signer-list
```

## Test

```sh
node route.test.mjs
```

The test asserts the response shape: `signers` is an array of at least three
entries, every `keyType` is one of the supported values, every `weight` is a
positive number, ids are unique, and the fixture covers more than one key type.

## Example

Request:

```
GET /signer-list
```

Response:

```json
{
  "accountId": "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
  "signers": [
    {
      "id": "sig_001",
      "label": "Primary device",
      "keyType": "ed25519",
      "publicKey": "GCKFBEIYV2V5BVZ6Q7V7QV7QV7QV7QV7QV7QV7QV7QV7QV7QV7",
      "weight": 10,
      "addedAt": "2026-01-14T09:20:00.000Z"
    },
    {
      "id": "sig_002",
      "label": "Passkey (browser)",
      "keyType": "secp256r1",
      "publicKey": "PBKDF1234567890ABCDEF1234567890ABCDEF1234567890ABCD",
      "weight": 5,
      "addedAt": "2026-02-02T17:45:00.000Z"
    }
  ],
  "threshold": 10
}
```

Any other method or path returns `404` with `{ "error": "not_found" }`.
