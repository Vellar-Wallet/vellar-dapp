# Security Model

Security is a functional requirement in VELA, not a phase. The core principles:

## No private-key custody

VELA never holds, imports, or exports a user's private keys.

- The **web wallet** is controlled by a **passkey** (WebAuthn). The private key
  lives in the device's secure enclave and never leaves it.
- The **extension** holds a **non-extractable** WebCrypto key (its device
  signer) generated in the browser — it cannot be exported, only used to sign.
- The backend has **no signing endpoint**. It submits already-signed
  transactions; it can never sign on a user's behalf.

There is deliberately no seed phrase and no key-import flow.

## No silent signing

Every signature requires an explicit, human review:

- **Payments** show a review dialog (amount, recipient, network) *before* the
  passkey prompt.
- **Policy deploys** simulate first, then require a passkey approval to attach.
- **Extension dApp signing** shows the requesting origin and a decoded summary
  of the transaction on every request — even when the origin already has a
  standing permission grant.

## Origin-aware permissions (extension)

- The requesting origin is derived **only from the trusted browser sender**,
  never from anything the page supplies. Lookalike / non-http(s) origins are
  rejected.
- dApp permissions are scoped to `origin + network`. The provider protocol is
  zod-validated; spoofed or malformed messages are dropped at validation.
- The MAIN-world provider is stateless; the isolated-world bridge only relays
  schema-valid envelopes. Minimal local state is kept (address + grants; the
  device key is non-extractable in IndexedDB).

## Bounded extension sessions

The device signer is added with a **7-day on-chain expiration** — a paired
session key, not a permanent co-owner. This bounds the damage window if a device
is compromised. Re-pairing is one passkey tap; revocation from the web app's
Settings is an immediate on-chain remote kill.

## Fee sponsorship without exposure

Fees are sponsored so the wallet holds no XLM. The relayer API key and the
sponsor secret are **server-side only** — all submissions round-trip through the
backend, and no sponsor material is ever sent to a client.

## Policies are enforced, not promised

Account policies (e.g. spending limits) are enforced **on-chain by a Soroban
contract**, not by client-side checks. A spending-limit policy is a cumulative
rolling-window allowance — not a per-transaction cap — because policy signatures
are secretless (see [Policy Contract](./policy-contract.md) for why this
distinction matters).

## Destructive flows are guided, never one-click

Account cleanup and merge are guided planners with explicit per-step review.
Merges refuse to proceed until the account is verified merge-ready, and every
cleanup transaction is shown before signing.

## Backend hardening

CORS is locked to the configured web-app origin. Critical actions
(wallet.created, wallet.connected, tx.submitted, session.revoked) are recorded
to an audit log. Rate limiting, CSRF, replay protection, and a formal security
review — including the smart-contract audit checklist — are tracked hardening
work before any production/mainnet use.

## Current limitations (be honest)

- The spending-limit policy contract is **testnet-only and not yet audited** for
  mainnet.
- Server-side permission records are not yet mirrored (the extension-local store
  is authoritative today).
- Full rate-limiting / CSRF / replay protection is pending the hardening phase.
