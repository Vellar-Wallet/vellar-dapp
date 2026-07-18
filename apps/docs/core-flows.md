# Core Flows

End-to-end descriptions of the main user journeys and how they map to code.

---

## 1. Create a wallet (passkey onboarding)

**User sees:** an onboarding screen; taps "Create wallet", completes Face ID /
Touch ID; lands on the dashboard with a new account.

**What happens:**

1. `@vela/wallet-sdk`'s PasskeyKit connector calls `kit.createWallet(app, user)`,
   which registers a passkey and prepares the smart-account deployment.
2. The signed deployment transaction is posted to `POST /wallet/create`.
3. wallet-service submits it (relayer/sponsor) and persists the
   `keyId → contractId` mapping and a session record.
4. The session (with the passkey `keyId`) is stored client-side so the wallet
   can reconnect without re-registering.

**On-chain:** a new passkey-controlled smart-wallet contract (a `C...` address)
is deployed. Fees are sponsored — the wallet holds no XLM to start.

---

## 2. Reconnect

**User sees:** "Sign in", one biometric prompt, back to their dashboard.

**What happens:** the connector calls `connectWallet({ keyId })` using the
stored credential id — no discovery ceremony. It resolves the contract via
`POST /wallet/connect` and reopens a session. After a page reload the kit
reattaches silently; the passkey prompt only appears at signing time.

---

## 3. Send a payment

**User sees:** a Send form → a **review dialog** (amount, recipient, network) →
a biometric prompt → "Payment confirmed", balance updates.

**What happens:**

1. `PaymentClient` builds the SAC transfer. The build **simulates**, so failures
   (e.g. insufficient balance) surface _before_ any signing prompt.
2. The user reviews and approves. Only then does the passkey sign the wallet's
   auth entries.
3. Signed XDR → `POST /wallet/submit` → tracked to finality → balances refetch.

**Key guarantees:** nothing is signed without explicit review (no silent
signing), and payments pin a short timeout to satisfy the relayer's timebounds.

---

## 4. Create and deploy a policy

**User sees:** the policy builder — pick a template, fill parameters, review the
generated artifacts (JSON, content hash, the honestly-labelled enforced cap),
then "Deploy to my account".

**What happens (spending limit):**

1. **Author:** `POST /policies/validate` then `POST /policies/generate` produce
   a policy record with a content hash and a manifest containing the on-chain
   constructor args derived from the user's chosen limit.
2. **Simulate:** `POST /policies/:id/simulate` dry-runs the deploy so a bad
   deploy never reaches the passkey.
3. **Deploy instance:** `POST /policies/:id/deploy-instance` deploys a
   configured policy-contract instance bound to the account (sponsor-funded, no
   passkey needed — the instance isn't a signer yet).
4. **Attach:** the web app builds `kit.addPolicy(contractId, …)`, the user
   passkey-signs it, and it's submitted. This runs the contract's `install`
   hook, which binds it to the wallet.
5. **Record:** `POST /policies/deploy` records the completed attach.

**On-chain:** a per-account Soroban policy contract enforcing a cumulative
rolling-window spend cap. See [Policy Contract](./policy-contract.md).

> Multisig-threshold and contract-allowlist templates are enforced by the smart
> wallet's native signer limits rather than a deployed contract. The timelock
> template is surfaced as "coming soon" (it needs its own contract).

---

## 5. Clean up and merge an old account

**User sees:** the cleanup wizard — inspect → plan review (per-blocker actions)
→ signed steps → merge, with a permanent-action warning. Never one-click.

**What happens:**

1. `POST /lifecycle/inspect` reads the classic account from Horizon.
2. `POST /lifecycle/plan` returns blockers (trustlines, balances, offers, data
   entries) with explicit actions and whether the account is merge-ready.
3. `POST /lifecycle/execute` builds **unsigned** cleanup transactions with
   watchable hashes. The user signs them in whatever wallet controls the
   classic account (VELA holds no classic keys); the wizard watches Horizon for
   each hash to auto-advance.
4. `POST /lifecycle/merge` refuses until merge-ready, then builds the
   `accountMerge`. Reclaimed XLM goes to the destination.

---

## 6. Pair the extension and sign a dApp transaction

**User sees (pairing):** in the web app, "Pair extension"; the extension popup
shows the origin + wallet and asks for consent; a passkey prompt confirms.

**User sees (signing):** a dApp requests a signature; the extension popup shows
the origin and a **decoded summary** of the transaction (e.g. "transfer 5 XLM
to …"); the user approves; the device key signs.

**What happens:**

1. **Pairing** generates a **non-extractable WebCrypto Ed25519 key** in the
   extension. The web app adds its public key as an on-chain signer via a
   passkey-approved `addEd25519`, with a **7-day expiration** — a session key,
   not a permanent co-owner.
2. **Connection** requests are approved per-origin; the origin is derived only
   from the trusted sender, never the page.
3. **Signing:** every dApp transaction requires an explicit popup approval, even
   with a standing grant. The extension decodes the XDR to show what's being
   signed, then signs the matching auth entries with the device key (no passkey
   in the extension) and submits via the backend.

**Revocation:** remove the device signer on-chain from the web app's Settings —
a remote kill. The pairing also auto-expires after 7 days.
