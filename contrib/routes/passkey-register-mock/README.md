# Passkey Register Mock Route Module

This module simulates the server-side response to a passkey registration ceremony. It does not implement real WebAuthn logic.

## Requirements Covered
- Accepts a fake `credentialId` and `publicKey` string.
- Returns a `walletId` deterministically derived from the `credentialId`.

## Usage
Run the test script to assert that the same credential ID always produces the same wallet ID:

```bash
node test.js
```
