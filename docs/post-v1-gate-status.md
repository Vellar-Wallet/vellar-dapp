# Post-V1 decision gates — status record (#411, #412, #414, #415)

**Recorded 2026-09-25 against `dev` at `e26c0a8`.**

Each of these four issues says it must not be built until a condition holds. This
file records whether each condition holds, the evidence checked, and what would
unblock it. It exists because `docs/decisions.md` is gitignored (see
`security-audit.md`, "Context for a fresh clone"). A decision recorded there does
not reach contributors, so the gate status is tracked here. When a maintainer
records a decision in `docs/decisions.md`, update the matching section below.

| Issue | Gate                                                | Holds? | Built?                                                                                       |
| ----- | --------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| #415  | External Soroban-capable reviewer engaged           | No     | Scope package only: [`external-security-review-scope.md`](external-security-review-scope.md) |
| #414  | SDK-package decision (#413) has landed              | No     | No                                                                                           |
| #412  | A real cross-device / web-managed permissions need  | No     | No                                                                                           |
| #411  | Users actually need to hold/switch multiple wallets | No     | No                                                                                           |

"Holds? No" means no evidence was found. It does not mean the need will never
exist.

---

## #415 — External security review

**Gate:** an independent reviewer with Soroban experience is engaged and the scope
is agreed in writing.

**Status:** not engaged. Selecting and contracting a firm is a maintainer action
(budget, contract, repo access to `vellar-sdk`). The complete scope package,
reviewer criteria, findings format and re-review protocol are in
[`external-security-review-scope.md`](external-security-review-scope.md).
`security-audit.md` stays **NO-GO**.

---

## #414 — Docs site (`apps/docs`)

**Gate:** the `policy-sdk` / `lifecycle-sdk` decision (#413) has landed, so the
docs don't describe an API that is later deleted.

**Evidence checked:**

- #413 is open. `packages/policy-sdk` and `packages/lifecycle-sdk` on `dev` are
  still `export {}` stubs.
- An open, unmerged PR (#482) proposes deleting both. Until it merges or is
  rejected, the decision has not landed.

**Status:** blocked. Nothing was built.

### Groundwork for the scope decision (a proposal, not a decision)

The issue asks what `apps/docs` adds over docs.vellar.xyz. As of 2026-09-25:

| Content                                                                         | docs.vellar.xyz                               | `apps/docs` today          |
| ------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------- |
| `vellar-sdk` usage for x402 buyers / sellers                                    | Yes (Getting Started, Buyers, Sellers)        | No                         |
| Agent keys, policies, MCP payer, CLI, VS Code extension                         | Yes (Agent Tooling)                           | No                         |
| x402 facilitator operation                                                      | Yes (Operators: Run, Configuration, Limits)   | No                         |
| Wallet backend HTTP API (`/wallet`, `/policies`, `/lifecycle`, `/verification`) | No                                            | Yes (`api-reference.md`)   |
| Running this monorepo's stack locally                                           | No                                            | Yes (`getting-started.md`) |
| Wallet architecture, core flows, security model, policy contract                | Partly (security framing in the introduction) | Yes                        |
| End-user guide: onboarding, extension pairing, dApp permissions, recovery       | No                                            | No                         |

`apps/docs` currently holds eight Markdown pages and no `package.json`, build, or
CI step.

The non-overlapping ground is the **wallet product**: its backend HTTP API,
self-hosting, architecture/security model, and an end-user guide. SDK and x402
usage belongs on docs.vellar.xyz, and `apps/docs` should link there rather than
restate it. If #413 keeps either SDK package, its reference docs belong wherever
that package is published, not duplicated here.

This is groundwork for the maintainer's call. The scope, audience, content
ownership and deploy target still need to be decided and recorded (in
`docs/decisions.md` and here) before any page or build tooling is added.

**To unblock:** #413 resolved → scope decided → then choose the static-site tool,
add the build to `ci.yml`, and write only the decided pages.

---

## #412 — Server-side permission records (`permission-service`)

**Gate:** a cross-device or web-managed permissions need has actually appeared,
and the privacy tradeoff is recorded as worth it.

**Evidence checked:**

- Repo docs: the only mention is the backlog entry in `open-work-catalogue.md`
  ("build when a cross-device or web-managed-permissions need actually appears").
- Issue tracker: no issue other than #412 requests cross-device permissions;
  #412's comments are contributor applications only. Discussions are disabled.
- Code: the web app has no permissions view. Grants live only in extension
  storage (`apps/extension/lib/state.ts`).

**Status:** gate not met. Nothing was built.

### A second blocker the issue does not mention

`architecture-analysis.md` §5: the backend has **no user identity**. There is no
application-layer authentication on any route, and the only capability is the
wallet-service session id, deliberately scoped to the session routes and "not
honored anywhere else" (RA-3/M1). §8 Q4 records that no server-side auth is
planned.

Server-side permission records need a principal to belong to, and an
authenticated way for the extension and web app to read and write them. That is
a new AuthN layer (e.g. a WebAuthn assertion verified server-side, or a
wallet-signed challenge), which is itself an architecture decision with its own
review. It cannot be improvised inside #412. The session capability can't be
reused either: widening it is exactly what RA-3/M1 ruled out.

### Constraints that must survive into any future design

Carried from #412, restated so they are not lost:

- **Extension-local grants stay the enforcement authority.** Server state may
  inform and sync, never grant. A synced "grant" from the server must require an
  explicit local approval before it has effect.
- **Revocation is local-first.** Revoke takes effect in the extension immediately
  and syncs later. It must never wait on the server.
- **Conflict rule fails closed.** Revoke wins over a concurrent or stale grant.
- **Records are keyed by origin + network + wallet (`accountId`)**, never origin
  alone.
- Privacy: the server would learn which dApps a wallet connects to. The decision
  record must state what is stored, retention, access, deletion and logging
  limits before implementation (`architecture-analysis.md` §6).
- Controls per `idea.md` §12: CSRF, rate limiting, audit logging.

**To unblock:** documented user demand → maintainer decision on the privacy
tradeoff → a separate decision on backend identity → then #412.

---

## #411 — Multi-wallet account selector (extension)

**Gate:** users actually need to hold/switch multiple paired wallets.

**Evidence checked:**

- Issue tracker: no user request outside #411; its comments are contributor
  applications only. #455 (extension top-bar restyle) mentions an "account
  switcher" from `design.md` §8. That is a visual spec and says "_if_
  multi-wallet switching lands". It is not evidence of demand.
- Code: single-wallet by design. `state.ts` holds one optional `pairedWallet`,
  and pairing a different address wipes every grant.

**Status:** gate not met. Nothing was built.

### Single-wallet assumptions to fix first, if it proceeds

- `packages/provider-sdk/src/permissions.ts` — `hasCapability` matches
  `origin + network` only and **ignores `accountId`**, although every grant
  carries one. Today this is safe only because re-pairing a different address
  clears all grants (`setPairedWallet`). Under multi-wallet, a grant to wallet A
  would authorize wallet B. The same applies to `addGrant` / `revokeGrant` in
  `apps/extension/lib/state.ts`. This must be wallet-scoped, with cross-wallet
  regression tests, **before** a second wallet can be paired.
- `apps/extension/lib/state.ts` — singleton `pairedWallet`, not a keyed set.
- `apps/extension/lib/router.ts` and `entrypoints/background.ts` — read
  `state.pairedWallet` directly for connect, sign and revoke, and the pair
  handler overwrites it. (#411 names `pair-origins.ts`, but that module only
  holds the web-app origin allowlist and needs no change for multi-wallet.)
- Pending approvals, device keys (`device-key.ts`) and signer expiry must be
  pinned to the wallet they were created for. An approval raised for wallet A
  must never sign as wallet B after a switch.
- Every approval surface must name the signing wallet as prominently as the
  origin (`technical-doc.md` §8.2).

**To unblock:** documented user demand, recorded by the maintainer → then #411,
starting with account-scoped permission checks.
