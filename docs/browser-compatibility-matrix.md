# Browser compatibility matrix: passkeys and the extension

Catalogue item 1.3, technical-doc.md §5.1. The onboarding path every user hits first
is **create a passkey, connect (find it again), sign**. This page has two halves:

1. **Automated (Chromium only):** `apps/web/e2e/passkey-compat.spec.ts`, 14 tests,
   tagged `@ci`. It uses the CDP WebAuthn virtual authenticator, needs no backend, and
   mirrors the exact options passkey-kit@0.14.0 sends (`webauthn-ops.js`: ES256 only,
   `residentKey`/`userVerification` `"preferred"`, random challenge).
2. **Manual (everything else):** the checklist below. Safari, Firefox and mobile cannot
   be driven by the virtual authenticator, so a person runs it and fills the table.

**Status: only the Chromium column has been run. Every other cell is NOT RUN.**

## Automated result (Chromium, headless, virtual authenticator)

14 passed. What it covers, and what it deliberately does not:

| Scenario                                                                  | Covered | Notes                                                |
| ------------------------------------------------------------------------- | ------- | ---------------------------------------------------- |
| Platform authenticator detected                                           | yes     |                                                      |
| Create: ES256 resident credential on the page's `rpId`                    | yes     | checks user handle, resident flag, P-256 key         |
| Connect: discoverable `get` returns the user handle                       | yes     | also with two passkeys                               |
| Sign: assertion verifies, binds challenge and rpId                        | yes     | verified in Node, not trusted from the browser       |
| Sign: converts to the 64-byte low-S contract form                         | yes     |                                                      |
| Counter increments per ceremony                                           | yes     |                                                      |
| Duplicate registration -> `InvalidStateError` -> `credential-exists`      | yes     | via the real `normalizePasskeyError`                 |
| UV required but not performed -> `NotAllowedError` -> `cancelled`         | yes     |                                                      |
| Abandoned ceremony -> `AbortError` -> `aborted`                           | yes     |                                                      |
| Real `/app`: Create registers a credential; dead backend ends in an error | yes     | backend and RPC blocked                              |
| Real `/app`: Sign in sends the credential id to `/wallet/connect`         | yes     |                                                      |
| Deploying the smart account, funding, submitting a payment                | **no**  | needs a live backend; see the stale live specs below |

### Findings from building it

- **An unsatisfiable algorithm list is reported as `NotAllowedError`, not
  `NotSupportedError`.** passkey-kit is ES256-only. On an authenticator without ES256,
  Chromium hides the reason from the page, so the app would show "cancelled" instead of
  "unsupported". Rare in practice; pinned by a test so a browser change is noticed.
- **The existing live-testnet specs (`wallet`, `policy`, `extension`) are stale.** They
  use selectors such as `p.mono` that no longer exist after the rebrand. They were not
  run for this work.
- **Local setup trap:** the installed `@playwright/test` expects a Chromium build that
  was not in the local browser cache. `pnpm exec playwright install chromium` (from
  `apps/web`) fixes it; CI already runs that step.

## Manual checklist

Run each scenario on each target. Record **P**ass / **F**ail / **N/A**, the browser and OS
version, the authenticator used, and for any failure the exact error name and message
(open the console; the app maps `DOMException` names through `normalizePasskeyError`).

### Targets

| #   | Target                                               | Authenticator to use                                      |
| --- | ---------------------------------------------------- | --------------------------------------------------------- |
| T1  | Chrome, latest, macOS                                | Touch ID (Google Password Manager / iCloud)               |
| T2  | Chrome, latest, Windows                              | Windows Hello                                             |
| T3  | Edge, latest, Windows                                | Windows Hello                                             |
| T4  | **Safari, latest, macOS**                            | iCloud Keychain passkey                                   |
| T5  | **Safari, iOS (current and previous major)**         | iCloud Keychain, Face ID                                  |
| T6  | **Firefox, latest, macOS and Windows**               | platform authenticator if offered, else a hardware key    |
| T7  | Chrome, Android                                      | Google Password Manager, screen lock                      |
| T8  | Cross-device: desktop browser using a phone via QR   | hybrid transport                                          |
| T9  | Hardware security key (USB/NFC) on a desktop browser | a FIDO2 key with a PIN                                    |
| T10 | Extension: Chrome (MV3)                              | n/a: the extension signs with a device key, not a passkey |
| T11 | Extension: Firefox, if shipped                       | as T10                                                    |

### Scenarios

| ID  | Scenario                 | Steps                                                         | Pass criteria                                                                              |
| --- | ------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| S1  | Support gate             | Open `/app` over **https**                                    | Both **Create wallet** and **Sign in** enabled; no "unsupported" banner                    |
| S2  | Insecure context         | Open `/app` over plain http on a non-localhost host           | The unsupported banner names an insecure context; both buttons disabled; no crash          |
| S3  | Create                   | Enter a name, **Create wallet**, approve the OS prompt        | Credential created; wallet deploys; lands on `/dashboard`                                  |
| S4  | Connect                  | Sign out, then **Sign in**                                    | OS offers the passkey without typing anything; lands on the same wallet (same contract id) |
| S5  | Sign                     | Send a small testnet payment, confirm with the passkey        | Payment confirmed; the review dialog showed the right amount and recipient first           |
| S6  | Cancel                   | Start **Create wallet**, dismiss the prompt                   | App returns to idle with a calm message; no half-created wallet; can retry immediately     |
| S7  | Duplicate                | Create twice with the same passkey store                      | Clear "already exists" handling, no crash                                                  |
| S8  | Two passkeys             | Create two wallets, then **Sign in**                          | The picker lists both; each opens its own wallet                                           |
| S9  | Reload                   | Reload on the dashboard                                       | Session restores without a prompt (resume), signing still prompts                          |
| S10 | Private window           | Repeat S3 and S4 in a private/incognito window                | Works, or fails with a clear, specific message (record which)                              |
| S11 | Blocked storage          | Block site data/cookies, repeat S9                            | Degrades with a message, not a blank page                                                  |
| S12 | No authenticator         | A machine with no platform authenticator and no key           | A clear message, not an endless spinner                                                    |
| S13 | Back/forward cache       | Complete S4, navigate away and back                           | No stale "busy" state                                                                      |
| S14 | Pairing (T10/T11)        | Pair the extension with the web app, approve a dApp request   | Popup opens, shows the origin, no silent signing, device key survives a browser restart    |
| S15 | MV3 service worker (T10) | Idle 1+ minute so the worker sleeps, then request a signature | Request still delivered and shown                                                          |

### Known risks to look for, by browser

- **Safari:** WebAuthn must start from a user gesture; the **Create wallet** and **Sign
  in** handlers must call the credential API synchronously from the click, not after an
  `await`. Safari is also strict about `rpId`; check S1 on the production host, not only
  localhost. iCloud Keychain passkeys sync, so S4 may offer more than one.
- **Firefox:** historically no platform authenticator on some operating systems, so S12
  may be the normal case there: confirm the message and that a hardware key still works.
- **iOS:** in-app browsers and some webviews have no WebAuthn at all; confirm S1/S12 show
  the support message.
- **Android Chrome:** the credential picker differs; S4 must work with a screen-lock-only
  authenticator.
- **Hybrid (T8):** slow; confirm the app's timeouts do not fire before the phone responds
  (the kit uses `WEBAUTHN_TIMEOUT_MS`).
- **All:** S5 must show the transaction details before the passkey prompt, never after.

### Results

Copy this table into the PR or release notes and fill it in.

| Target                           | S1      | S2  | S3  | S4  | S5  | S6  | S7  | S8  | S9  | S10 | S11 | S12 | S13 | S14 | S15 | Tester / date / versions                                                                   |
| -------------------------------- | ------- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ------------------------------------------------------------------------------------------ |
| T1 Chrome macOS                  | NOT RUN |     |     |     |     |     |     |     |     |     |     |     |     |     |     |                                                                                            |
| T1 (automated, Chromium virtual) | P       | n/a | P*  | P   | P*  | P   | P   | P   | n/a | n/a | n/a | n/a | n/a | n/a | n/a | passkey-compat.spec.ts, 14/14. *WebAuthn ceremony only: no smart-account deploy or payment |
| T2 Chrome Windows                | NOT RUN |     |     |     |     |     |     |     |     |     |     |     |     |     |     |                                                                                            |
| T3 Edge Windows                  | NOT RUN |     |     |     |     |     |     |     |     |     |     |     |     |     |     |                                                                                            |
| T4 Safari macOS                  | NOT RUN |     |     |     |     |     |     |     |     |     |     |     |     |     |     |                                                                                            |
| T5 Safari iOS                    | NOT RUN |     |     |     |     |     |     |     |     |     |     |     |     |     |     |                                                                                            |
| T6 Firefox                       | NOT RUN |     |     |     |     |     |     |     |     |     |     |     |     |     |     |                                                                                            |
| T7 Chrome Android                | NOT RUN |     |     |     |     |     |     |     |     |     |     |     |     |     |     |                                                                                            |
| T8 Cross-device                  | NOT RUN |     |     |     |     |     |     |     |     |     |     |     |     |     |     |                                                                                            |
| T9 Hardware key                  | NOT RUN |     |     |     |     |     |     |     |     |     |     |     |     |     |     |                                                                                            |
| T10 Extension Chrome             | NOT RUN |     |     |     |     |     |     |     |     |     |     |     |     |     |     |                                                                                            |
| T11 Extension Firefox            | NOT RUN |     |     |     |     |     |     |     |     |     |     |     |     |     |     |                                                                                            |
