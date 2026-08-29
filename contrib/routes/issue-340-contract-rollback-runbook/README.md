# Issue 340 — Rollback Procedure for Failed Soroban Contract Deployments

Sandboxed doc (per `contrib/README.md` — this cannot live at
`contracts/ROLLBACK.md` directly; see the PR description) documenting how to
detect a failed Soroban contract deployment on Vellar, the recovery options,
and a post-rollback consistency checklist. Written to be dropped in next to
`contracts/README.md` once a maintainer accepts it.

This is grounded in the real deploy tooling and reproducibility model already
documented in `services/worker-service/README.md` and `contracts/README.md` —
this repo has no scripted `deploy.sh`; deploys are the manual `stellar
contract build` / `stellar contract upload` / `stellar contract deploy` flow
described there, run against the canonical Docker build image
(`vela-verify:1.94.0`, pinned in `contracts/rust-toolchain.toml` and built
from `infra/docker/verification-builder.Dockerfile`).

## Where this fits in `contracts/`

Per `contracts/README.md`, the workspace currently holds:

- `contracts/attestation-registry/` — on-chain attestation mirror contract
  (`packages/service-kit`/`services/worker-service` write to it via
  `createRegistrySubmitter`, see `services/worker-service/src/registry-submitter.ts`).
- `contracts/policy-templates/` — `spending-limit/`, `token-spending-limit/`,
  `verified-recipient/` policy contracts (deployed per-account by
  `policy-service`, per `docs/design-provenance-gated-spending.md`).

Both are Soroban/Rust contracts built with the same pinned toolchain
(`contracts/rust-toolchain.toml`) and deployed with the Stellar CLI. This doc
applies to a failed deployment of either.

## 1. Detecting a failed deployment

A Soroban deploy is really three steps that can each fail independently —
detect failure at the step it actually happened, not just "something broke":

### 1a. Build step fails
`stellar contract build` (inside the canonical image, per
`services/worker-service/README.md` §"Reproducibility model") exits non-zero.
**Signal**: the CI/deploy job itself fails before any network call — check the
build log for a Rust compile error, a toolchain/target mismatch (compare
against `contracts/rust-toolchain.toml`'s pinned `1.94.0` + `wasm32v1-none`),
or a dependency that couldn't be vendored/pre-fetched (the build runs
`--network=none`, so an unvendored dependency fails here, not later).
**Nothing was ever uploaded or deployed — no on-chain state changed.**
Recovery is just "fix the build and retry"; skip straight to redeploy below.

### 1b. Upload step fails (`stellar contract upload`)
**Signal**: the CLI returns a non-zero exit and/or the RPC response includes
an error (insufficient balance on `--source-account`, a malformed/re-optimized
wasm — remember `--optimize=false` is required per the worker-service README,
since `stellar contract build` already optimizes and re-optimizing on upload
changes the hash and breaks verification), or an RPC timeout/5xx from the
configured `--rpc-url`.
**Signal to distinguish from 1c**: no wasm hash was returned, or the returned
hash doesn't match what a **local** `sha256sum` of the built `.wasm` file
produces. Nothing is deployed yet — the wasm may or may not be on the ledger
depending on exactly where the call failed.
**Recovery**: retry the upload with the SAME already-built wasm bytes (don't
rebuild — rebuilding on a non-hermetic host can silently produce
byte-different output per the reproducibility note in
`services/worker-service/README.md`). If upload keeps failing, check
`--source-account` funding and RPC health before retrying again.

### 1c. Deploy/instantiate step fails (`stellar contract deploy` /
the constructor/`__constructor` invocation)
**Signal**: the wasm uploaded successfully (hash confirmed) but the
`deploy`/instantiate transaction itself failed — insufficient fee, a failed
constructor precondition (e.g. a policy contract's constructor rejecting bad
initial parameters), or the transaction simply never got included (check the
tx hash on a Horizon/Explorer lookup — this repo already links an explorer
per `docs/link-explorer` conventions).
**Signal to distinguish from a genuinely "half-deployed" contract**: Soroban
contract creation is atomic per Stellar's transaction model — either the
`CreateContract`/instantiate operation lands in a **successful** transaction,
in which case the contract address exists and is initialized, or it doesn't
land at all. There is no persistent "wasm uploaded but contract-instance
half-created" on-chain state to reconcile — check the transaction result
(`SUCCESS` vs any non-success result code), not the contract address's mere
existence, since a failed tx never produces a live contract ID to begin with.

### General signals across all three steps
- CI job for the deploy step is red.
- The Docker build's exit code and stdout/stderr log (per the sandbox
  described in `services/worker-service/README.md` §"Build sandbox" —
  `--network=none`, resource caps, a SIGKILL on timeout) — a SIGKILL exit
  code specifically means the build hit its timeout/memory/pids cap, not a
  code error.
- For a policy-service-initiated deploy specifically: `policy-service`'s own
  spend-budget ledger (`FIX 3`, mirrored in `services/wallet-service/src/index.ts`'s
  `budgetLimitsFromEnv` pattern) would show the deploy attempt debited against
  the `deploy` budget line even if the on-chain tx failed — a budget-vs-chain
  mismatch itself is a signal worth checking (see the consistency checklist
  below).

## 2. Recovery options

### Option A — Redeploy (default path for 1a/1b, and most of 1c)
Since a failed build/upload/deploy leaves no live contract behind (see the
atomicity note above), the default recovery is simply: **fix the root cause,
then rerun the deploy from the failed step onward** using the exact commands
in `services/worker-service/README.md` §"Reproducibility model":

```sh
# 1. rebuild in the canonical image (deterministic — only needed if 1a failed,
#    or if you're not certain the previously-built wasm bytes are still valid)
docker run --rm -v "$(pwd)/contracts:/work" -w /work vela-verify:1.94.0 \
  stellar contract build

# 2. upload — REQUIRED --optimize=false (build already optimized; see above)
stellar contract upload \
  --wasm contracts/target/wasm32v1-none/release/<name>.wasm \
  --optimize=false \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  --source-account <funded-identity>

# 3. deploy/instantiate using the confirmed wasm hash from step 2
stellar contract deploy \
  --wasm-hash <hash-from-upload> \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  --source-account <funded-identity> \
  -- <constructor-args-if-any>
```

If a **different** contract address is produced on redeploy (expected — a new
deploy always gets a new contract ID unless using a deterministic
salt/CREATE2-style deploy), every place that referenced the old
(nonexistent) address must be updated. For this repo that's:
- `ATTESTATION_REGISTRY_ID` env var (`services/worker-service/src/config.ts`)
  if redeploying `attestation-registry`.
- Any policy-instance address `policy-service` recorded for an account, if
  redeploying a `policy-templates/*` contract instance.

### Option B — State reconciliation (only relevant for an already-LIVE contract
being upgraded, not a from-scratch failed deploy)
If the "deployment" in question was actually a contract **upgrade**
(`stellar contract upgrade` swapping the wasm on an existing, already-live
contract address) and that upgrade transaction failed, the existing contract
instance and its on-chain storage/state are untouched — Soroban's upgrade
model doesn't mutate storage as part of a wasm swap, and a failed upgrade tx
never lands, so the previous wasm keeps serving the contract exactly as
before. **No state reconciliation is needed on-chain** — recovery is the same
as Option A: fix the root cause and retry the upgrade tx.

The one case genuine state reconciliation applies: if this repo's
`services/worker-service` attestation mirror (see
`docs/design-provenance-gated-spending.md`) had already recorded an
attestation for contract code that the deploy/upgrade never actually
delivered — i.e., the **mirror says "attested to hash X"** but the on-chain
contract is still running the old wasm (a failed upgrade). That's a mirror
that needs correcting, not the chain: rerun the worker-service's own upgrade
sweep (`services/worker-service/src/index.ts`'s `runSweep`/`attestor` — "revoke
attestations whose contract was upgraded or deleted") or, if urgent, revoke
the stale attestation manually via the registry submitter path before the
sweep's next scheduled pass (`ATTESTATION_SWEEP_MS`, default 10 minutes).

### Option C — Abandon and use a fresh address (last resort)
If a partially-failed deploy left an unwanted-but-harmless contract instance
live on-chain (e.g. step 1c's tx actually succeeded with bad constructor args,
producing a working-but-misconfigured contract) and there's no admin/upgrade
path to fix it in place, the pragmatic recovery is: deploy a fresh, correctly
configured instance at a new address and update every reference to point at
the new one (same reference-update list as Option A). The old, misconfigured
contract instance is simply abandoned — Soroban contracts have no "delete"
that reclaims the address for reuse, so there's no cleanup step beyond
updating references and, if it holds any funds, sweeping them out via
whatever admin function it exposes (dependent on the specific contract's
`policy-templates/*` variant — check its `Cargo.toml`/source for an
admin-withdraw entrypoint before assuming funds are stuck).

## 3. Post-rollback consistency checklist

Run through all of these before considering the incident closed:

- [ ] **Confirm the failed transaction's actual on-chain result.** Look up
      the tx hash (Horizon or an explorer link, per this repo's
      `docs/link-explorer` branch conventions) and confirm it shows a
      non-success result code — don't rely solely on the CLI's local exit
      code, since a tx can fail on-chain for reasons the CLI surfaces
      differently (e.g. `txFAILED` vs a client-side RPC timeout that doesn't
      tell you whether the tx ultimately landed).
- [ ] **Confirm no address ended up referenced by application code before
      being live.** Grep `services/*/src` and `.env`/`.env.example` for the
      contract address you were about to deploy — if a config change landed
      (e.g. via a deploy PR) referencing the new address before the deploy
      actually succeeded, revert that reference until redeploy succeeds, so
      no service starts calling a nonexistent/misconfigured contract.
- [ ] **If a spend budget was involved** (deploys funded through
      `policy-service`'s or `wallet-service`'s sponsor/relayer path — see
      `services/wallet-service/src/index.ts`'s `budgetLimits.deploy` line),
      confirm the budget ledger's debit matches what was ACTUALLY spent
      on-chain. A failed-but-fee-charged transaction still consumes network
      fee even though the contract never deployed — the budget line should
      reflect that real spend, not zero it out, but should also not double-
      count if a retry is about to debit again for the same logical deploy.
- [ ] **If this was an attestation-registry-relevant contract**, confirm
      `services/worker-service`'s attestation mirror doesn't reference a
      hash/address that was never actually deployed — see Option B above.
- [ ] **Rerun the smoke test** (see issue #339's
      `contrib/routes/issue-339-predeploy-smoke-test/`) against the
      environment before considering the system healthy again — a failed
      deploy is exactly the kind of event that should trigger a fresh
      pre-deploy/post-incident health pass, not just a manual "looks fine"
      check.
- [ ] **Document the incident** in whatever this repo's decision-record
      convention resolves to (`docs/decisions.md` is referenced repo-wide as
      the place for this, though note it's currently gitignored in `main` —
      see the PR description for how this was handled) — capture the root
      cause, which step failed, and which recovery option was used, so the
      next occurrence has a faster diagnosis path.

## Explicit non-goals

This doc does not cover: mainnet-specific deploy governance (see
`docs/security-audit.md`'s mainnet-blockers material and the
`security/mainnet-blockers` branch for that), or a scripted/automated
rollback tool — today's deploy flow (per `services/worker-service/README.md`)
is entirely manual CLI invocation, so this runbook is written for a human
operator running these commands by hand, not a CI job.
