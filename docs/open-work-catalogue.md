# Vellar wallet — catalogue of open work

**Compiled 2026-09-07** from `BUILD-PLAN.md`, verified against the code where a
checkbox looked stale. For sequencing discussion, not a commitment.

**Where things stand:** 97 items done, 30 open. Phases 1, 4, 5 and 6 are
complete. The MVP gate (Phase 3) and V1 gate (Phase 6) are both met. What is
left splits into four groups: hardening the thing that exists, the agent-payments
phase, empty SDK packages, and a post-V1 backlog.

**Two corrections to BUILD-PLAN.md found while compiling this** — worth fixing in
the tracker:

1. The VS Code extension's "slice two (scoped, not started)" is **shipped**. The
   sidebar, both tabs, activation flow and Bazaar pagination all landed; the
   extension is at v0.2.3 on the marketplace, not the v0.1.3 the plan records.
2. The upstream x402 credential work is recorded as unstarted here, but the
   facilitator repo has it filed as `x402-foundation/x402#3158`. Someone should
   reconcile which parts remain.

---

## Group 1 — Hardening what already exists (Phase 7)

The only gaps in the doc-defined path to a shippable product. These are also
exactly what the funding slide in the LAVA deck promises, so they are the items
with an external commitment attached.

| #   | Item                                                                   | Notes                                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | **Security review incl. smart-contract checklist** (idea.md §12)       | Blocks mainnet. Two internal reviews exist; this is the external one. Longest lead time of anything on this list — start it before it becomes the critical path.                                                                                                                         |
| 1.2 | **Replay protection on the sponsor-submission path** (idea.md §12)     | Narrow and well-bounded: the wallet/relayer path only. Good candidate for a first task.                                                                                                                                                                                                  |
| 1.3 | **Browser compatibility testing** — passkeys + extension APIs (§5.1)   | Manual matrix work. Cheap, and it protects the onboarding flow every user hits first.                                                                                                                                                                                                    |
| 1.4 | **Staged deployment** local → dev → staging → production (idea.md §14) | Currently there is no staging tier. Everything else in this group is safer once this exists.                                                                                                                                                                                             |
| 1.5 | **Verification hardening** (idea.md §12)                               | Explicitly downgraded to nice-to-have in the plan. Four parts: metadata-tolerant comparison so third-party contracts built on a slightly different toolchain still verify; hermetic dep vendoring so arbitrary repos build offline; build timeouts + resource caps; signed job payloads. |

---

## Group 2 — Phase 8, agent payments

Post-V1 by the plan's own ordering, but this is the part the current pitch
narrative leans on hardest. **Two items here are claims already being made
externally** — flagged below.

| #   | Item                                              | Notes                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2.1 | **USDC / multi-asset plumbing** (§17.2)           | Token registry incl. the USDC SAC, multi-asset balances (the balance service already accepts a token list), asset selection in send/pay. Verified: USDC appears only in landing-page marketing copy, nowhere in wallet logic. **Prerequisite for most of this group.**                                                               |
| 2.2 | **Agent session keys** (§17.3, §5.1)              | Mint with expiry + per-token budget via passkey-approved `addEd25519`, list, revoke. Web Settings UI + SDK API, reusing the extension-pairing mechanism. **Externally claimed:** the deck says an agent gets its own restricted key. That is proven in the SDK and the facilitator, but the wallet-side UI to mint one is not built. |
| 2.3 | **Headless agent runtime example + docs** (§17.3) | Node signer using non-extractable WebCrypto Ed25519, plus an x402 client paying under a budget. This is the developer-facing artifact that makes 2.2 usable by anyone else.                                                                                                                                                          |
| 2.4 | **Upstream type-2 credential PRs** (§17.5)        | To `coinbase/x402` and OpenZeppelin's facilitator plugin. Unblocks the passkey payment path, which is blocked ecosystem-wide today. **Check first:** the facilitator repo records this as filed (`x402-foundation/x402#3158`) — confirm what is actually outstanding before starting.                                                |
| 2.5 | **Mainnet gate** (§17.4)                          | The §12 smart-contract checklist must cover agent keys and the token-scoped policy variant before any mainnet budget use. Depends on 1.1.                                                                                                                                                                                            |
| 2.6 | **Verified-only agent spending** (candidate)      | Gate agent payments on the verification service's trust status. Marked "decide during phase" — a scoping decision, not yet a task.                                                                                                                                                                                                   |

---

## Group 3 — Empty SDK packages

Two workspace packages are literally `export {}`. This matters more than it
looks: the plan blocks the docs site on these having stable public APIs.

| Package                     | State                                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/policy-sdk`       | **Stub** — `export {}` and a comment. Both are declared in `apps/web/next.config.ts` transpile list, so the wiring is already there.                                    |
| `packages/lifecycle-sdk`    | **Stub** — `export {}` and a comment.                                                                                                                                   |
| `packages/verification-sdk` | Real: 237 lines + tests.                                                                                                                                                |
| `packages/ui`               | Real — a 2-line barrel re-exporting a tested `TrustBadge`, used by both the web app and the extension popup. (Line count alone makes this look like a stub; it is not.) |

The backend services these would wrap (`policy-service`, `lifecycle-service`)
are complete and tested, so this is packaging and public-API design rather than
new functionality. Worth deciding whether they are needed at all before building
them — the web app currently talks to those services without an SDK layer.

---

## Group 4 — Post-V1 backlog

User-approved on 2026-07-16 to be built after the doc phases. Nothing here is
committed; it is a menu.

**Wallet features**

- Standard wallet interface (SEP-43 / Stellar Wallets Kit) alongside
  `window.vela`, so existing Stellar dApps work with Vellar unmodified
- Receive flow + QR (SEP-7 payment URIs)
- Multi-passkey / signer management UI — add a second passkey, list and revoke
  all signers including device sessions. Contract primitives already proven
- Account selector (multi-wallet switching in the extension) — deferred from the
  MVP by decision; single-wallet pairing ships today
- Swaps / path payments (native DEX or Soroban AMMs)
- Scheduled / recurring payments (policy + device signer)
- Notifications — needs an events indexer in `worker-service`
- Contacts / address book with federated lookup (SEP-2)

**Infrastructure**

- Server-side permission records (`permission-service`) — deferred by decision;
  extension-local grants are authoritative and strictly more private. Build when
  a cross-device or web-managed-permissions need actually appears
- Docs site (`apps/docs`, scaffolded) — **blocked on Group 3.** Scope
  (SDK reference vs product guide vs both) still to be confirmed

**The two differentiator bets** — both carry hard constraints from an earlier
review. Read the full entries in `BUILD-PLAN.md` before scoping either; the
constraints are the difference between a real feature and security theatre.

- **Bet A — On-chain enforced safety policies.** Extends the existing
  spending-limit contract so unsafe transactions are rejected in `__check_auth`
  rather than warned about in the UI. Constraints: no price oracle exists on
  Soroban so rules must be token-denominated, never USD; "never sent before"
  requires the contract to keep its own recipient history on-chain (rent cost);
  `auth_contexts` must be parsed explicitly; work inside `__check_auth` must be
  bounded; scope to known transfer patterns only.
- **Bet B — Verified-only signing.** Ranked in the plan as the single most
  differentiating idea: the wallet only authorises interactions with contracts
  whose source is verified, turning the verification pipeline from a passive
  badge into an active signing gate. Constraint: verification truth is
  off-chain, so on-chain enforcement is an allowlist of verified wasm hashes fed
  by the verification service or an on-chain attestation registry. Non-negotiable
  honesty bar: **verified ≠ safe.** Needs an override path or users get stuck.

---

## Group 5 — Loose ends

| #   | Item                                                                            | Notes                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 5.1 | **Wallet contract upgrade flow** (`kit.upgrade(newWasmHash)`, passkey-approved) | Phase 3. Needed whenever `walletWasmHash` advances so existing wallets can talk to newer SDK bindings. See the wasm-hash finding in `docs/decisions.md`. The only MVP-era item still open.                                                             |
| 5.2 | **Dashboard account metadata / activity** (§5.2)                                | Phase 2. Needs transaction history; the plan pairs it with the tx pipeline slice. The last open item in an otherwise complete phase.                                                                                                                   |
| 5.3 | **App pages restyled** per design.md §7                                         | Onboarding, dashboard, settings, cleanup. Partially done in practice — `send-payment.tsx` and `cleanup/page.tsx` already use the design-system classes, so this needs an audit to establish what actually remains rather than a from-scratch estimate. |
| 5.4 | **Extension popup restyled** per design.md §8                                   | ~360×600 flat frame, balance header, quick actions, approval screens with a trust-signal hero.                                                                                                                                                         |
| 5.5 | **RFP interest form** (facilitator initiative)                                  | Draft exists locally, not sent. Open questions in the draft: decentralisation rationale, privacy plan, maintenance-commitment decision. Not engineering work — a decision.                                                                             |

---

## Known-broken, not in the plan

Found during a stack audit on 2026-09-05/06. None of these are BUILD-PLAN items,
but all are real:

- **Web app test suite: 0 failures (62 passing).** A false report of 34 failures
  on 2026-09-06 was caused by invoking vitest directly without the
  `NODE_OPTIONS=--no-experimental-webstorage` flag that the package script sets.
  The flag has been moved into `vitest.config.ts` and the suite now passes under
  any invocation method.
- **The explorer has no tests and no CI.** It is the strongest piece of external
  evidence in the pitch and its correctness is unguarded. It has already shipped
  one classifier bug that silently missed a settlement.
- **Facilitator settle probe was red for 5 days** (2026-08-31 → 09-05) after the
  channel pool made `CHANNEL_ACCOUNT_SECRET_KEYS` required with no default; the
  probe workflow was never given it, so the facilitator refused to boot in CI.
  Check whether this has been fixed.
- **Four of six repos declare no licence.** Only the facilitator (Apache-2.0)
  and the published SDK do.
- **Single points of failure, all one person:** sponsor secret key, Turso auth
  token, Render account, npm publish rights, marketplace publisher, DNS. No
  multisig anywhere. The plan lists "M5 multisig attestor" as an unmet mainnet
  prerequisite.
- **Four wallet contracts have no deployment record** — the attestation registry
  and three policy templates are written and tested but not deployed to mainnet;
  the registry has never run outside tests, and nothing in production depends on
  it yet.

---

## Suggested reading order for whoever picks this up

1. `BUILD-PLAN.md` — the tracker, and the source for everything above
2. `technical-doc.md` — authoritative spec; §13 phases, §14 MVP, §15 V1
3. `idea.md` — §6 interfaces, §12 security controls, §15 testing strategy
4. `docs/decisions.md` — why things are the way they are; large but load-bearing

The project rule is that an item is not done without tests, and that deliberate
deviations get recorded in `docs/decisions.md`.
