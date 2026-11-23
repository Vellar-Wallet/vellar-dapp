# x402 cold start and retry safety (issue #476)

## The measured facts

- **Cold start:** `render.yaml`'s own comment states the free-tier web
  service (`@vellar/all-in-one`, the single process hosting the gateway,
  wallet, lifecycle, and policy services) sleeps after 15 minutes idle and
  takes roughly 1 minute to cold-start on the next hit.
- **The x402 payment gate's own timeout budget:** both x402-gated routes
  (`/lifecycle/execute` in `lifecycle-service`, `/verification/:contractId`
  in `verification-service`) declare `maxTimeoutSeconds: 300`. `api-gateway`'s
  own `connectionTimeout` defaults to `310_000ms` (310s), deliberately 10s
  above that, so the gateway does not kill a legitimate slow-but-correct
  proxied response before the payment path's own budget does (see the
  comment on `GatewayOptions.requestTimeoutMs` in
  `services/api-gateway/src/server.ts`).
- **Conclusion: a cold start alone does not exceed the payment gate's own
  timeout budget.** ~60s cold start against a 300s (payment gate) / 310s
  (gateway) ceiling leaves roughly 4x headroom. The risk this issue raises
  is not "the request times out," it is that an impatient caller (in
  particular an autonomous agent with its own, possibly much shorter,
  client-side timeout) gives up and retries well before the real 300s
  budget is exhausted, and that retry is what risks a second payment.
- **A second, compounding cold-start source not mentioned in the issue
  text:** `HTTPFacilitatorClient` defaults to
  `https://vellar-facilitator.onrender.com` (see `services/lifecycle-service`
  and `services/verification-service`'s `server.ts`). That facilitator is a
  separate deployment, in a separate repository, not inspectable from here.
  If it is also on a free/sleeping tier, a request could incur two
  independent cold starts (backend, then facilitator) in the worst case.
  This is disclosed here as a fact worth checking with whoever owns the
  facilitator's deployment; it cannot be measured or fixed from this repo.

## The real hazard, precisely

A caller (human browser or, more importantly, an autonomous agent using
`vellar-sdk`'s `X402Client.fetch()`) sends a request to an x402-gated route.
The backend is asleep. The caller's OWN client-side timeout (which may be
far shorter than the server's 300s/310s budgets, and is not controlled by
this repo at all) fires first. The caller interprets this as a failure and,
absent any way to check whether the first attempt actually settled, retries
by authorizing payment again.

Whether that second authorization is safe by itself depends on a detail
this repository cannot fully resolve: `docs/design-x402-sdk-client.md`
states the facilitator, not the client, rebuilds the settlement
transaction from the client's signed auth entry ("the facilitator
advertises `areFeesSponsored` and rebuilds the tx"). Whether the
facilitator's rebuild is itself idempotent against a repeated identical
auth entry (so a literal resend is a safe no-op) is a property of the
facilitator's own implementation, which lives in a separate service this
repository does not control or have visibility into. What IS certain,
independent of that detail: if the client instead builds and signs a
**new, independent** payment authorization on retry (rather than resending
the exact same one) because it has no way to tell the first attempt
succeeded, that is unambiguously a second, separately payable transaction.
That is a client-side decision, and nothing in this repository's backend
can distinguish "this is a legitimate second purchase" from "this is a
panic-retry of the first" without the client telling it so, or a
settlement-status-check endpoint to ask.

## What is, and is not, buildable from this repository

`vellar-sdk` (the actual client the issue's "SDK/agent clients" language
refers to, per `docs/design-x402-sdk-client.md`'s own description of
`X402Client.fetch()`) is a **separate repository**
(`Vellar-Wallet/vellar-sdk`), not part of this one. The retry-safety logic
this issue's "Option 3" acceptance criteria actually needs, either not
retrying automatically at all and surfacing the ambiguity to the caller, or
checking settlement status before authorizing a second payment, has to
live in that SDK's `x402-client.ts`, which this repository cannot edit or
test.

Also checked: no settlement-status-check endpoint exists anywhere in this
repository's x402-gated services today (`grep` across every service's
`server.ts` for anything resembling "check whether payment X already
settled" returns nothing). Without one, even a well-behaved SDK client has
no way to ask "did my first attempt actually go through?" before deciding
whether to retry; it can only avoid retrying blindly. Building that
status-check endpoint is real, substantive new scope (which x402-gated
route(s) need it, what identifier a caller would check against, whether it
needs its own auth) that this issue's own scope does not specify precisely
enough to build without guessing at a client-facing API shape the actual
SDK consumer never asked for.

## Recommendation (Option 3, the one the issue itself says is "necessary
regardless")

1. **The SDK must not auto-retry a timed-out x402 request by authorizing a
   new payment.** A timeout should surface to the caller as an explicit,
   distinguishable error (not a generic network failure indistinguishable
   from "the resource genuinely doesn't exist"), so the calling application
   or agent can decide whether to check for an existing settlement (once
   such an endpoint exists) or prompt a human before paying again. This is
   a `vellar-sdk` change, tracked as a follow-up there since it cannot be
   made or tested from this repository.
2. **A settlement-status-check endpoint is a real, separate piece of
   scope** worth its own issue once someone can specify which route(s) need
   it and what a caller would check it against (the settlement tx hash from
   a prior attempt's response, if any was received; the payment
   authorization's own identifier, if x402 gives one). Not invented here.
3. **The two-cold-start-sources fact (backend + possibly facilitator)**
   should be confirmed with whoever owns the facilitator deployment, and if
   it is also free-tier, the keep-warm-vs-paid-tier decision (the issue's
   options 1/2) should account for both, not just this repository's own
   service.

## What this issue's own acceptance criteria this runbook does NOT close

- "Decision recorded in `docs/decisions.md`": that file is gitignored in
  this repository (grouped with `idea.md`/`technical-doc.md`/
  `BUILD-PLAN.md` as private planning docs). A local, equivalent decision
  entry exists; ask directly if useful for review, or record it there once
  a maintainer picks between the keep-warm/paid-tier/accept-and-handle-
  client-side options this issue itself leaves open.
- "Double-payment on retry proven impossible, with a test": cannot be
  proven or tested from this repository alone, since the retry behavior
  that causes it lives entirely in the separate `vellar-sdk` client, not
  here.
- "Client guidance documented for agent integrators": this document is
  that guidance for whoever picks up the `vellar-sdk` side of the fix; it
  is not itself SDK-facing documentation (e.g. a README section in
  `vellar-sdk`), which belongs in that repository.

## Which claims are verified against code, and which cannot be (issue #752)

`pnpm check:runbooks` (`scripts/runbook-freshness.ts`, run in CI) checks, against
the real source files, every claim in this runbook that this repository can
actually verify:

- Both x402-gated routes (`POST /lifecycle/execute` and
  `GET /verification/:contractId`) declare `maxTimeoutSeconds: 300`.
- `api-gateway` defaults its request timeout to `310_000` ms and uses it as the
  `connectionTimeout`; the numbers are also checked against each other (310s is
  exactly 10s above the 300s payment gate, and a ~60s cold start leaves at least
  4x headroom inside it).
- `lifecycle-service` and `verification-service` default
  `HTTPFacilitatorClient` to `https://vellar-facilitator.onrender.com`.
- `render.yaml` still documents the free-tier sleep (15 minutes idle, about a
  minute to cold start).
- `docs/design-x402-sdk-client.md` still records that the facilitator rebuilds
  the transaction (`areFeesSponsored`).
- No route in `lifecycle-service`, `verification-service`, `wallet-service` or
  `api-gateway` is a settlement-status check, and the two x402 route files apply
  no retry helper of their own to a payment. (`GET /verification/:contractId/status`
  is a contract-verification lookup, not a payment-settlement check.)

If one of these changes, the check fails and names the claim, so this runbook is
updated instead of left describing the old behaviour.

### Claims that cannot be verified from this repository (documentation gaps)

These are real gaps in what this runbook can promise, listed here so nobody reads
them as tested:

1. **The client's retry behaviour.** The retry-safety logic itself (an SDK client
   not re-authorizing a payment after a timeout) lives in `vellar-sdk`'s
   `X402Client.fetch()`, a separate repository. Nothing here exercises it, so
   "the SDK does not auto-retry with a new payment" is a recommendation, not a
   tested guarantee. The only retry helper in this repository
   (`retryWithBackoff` in `packages/service-kit/src/retry.ts`) is not used by the
   x402 route files.
2. **Facilitator idempotence.** Whether the facilitator treats a re-sent,
   identical auth entry as a no-op is a property of a separate service.
3. **Facilitator hosting.** Whether `vellar-facilitator` is on a sleeping tier (a
   second cold start) can only be checked with its owner.
4. **"Double payment on retry is impossible."** Not provable from this
   repository, for the reasons above, and not claimed.
5. **The cold-start figure.** "About a minute" is the number `render.yaml`
   states; the check confirms `render.yaml` still says it, not that it is true.
6. **`docs/decisions.md`** is gitignored, so the references to it here cannot be
   checked in CI.

