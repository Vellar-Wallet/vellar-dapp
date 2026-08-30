# @vellar/worker-service

The deterministic contract-verification build worker (technical-doc.md §8.4).

It runs as its **own isolated process** — never co-located with the wallet/policy
services that hold sponsor keys, because it executes untrusted, submitter-provided
build inputs. It shares only the `verification_records` Postgres table with
`verification-service`: it claims `submitted` rows, rebuilds the contract,
compares the rebuilt wasm hash to the **on-chain** deployed hash, and writes
`verified` / `failed`.

## Two build modes (the 1A seam — see docs/decisions.md)

The build step is a pluggable `BuildExecutor`, chosen at startup from env:

| `VERIFY_BUILD_IMAGE` | Executor                                                                                   | Where                       |
| -------------------- | ------------------------------------------------------------------------------------------ | --------------------------- |
| **unset**            | `stubBuildExecutor` — deterministic synthetic bytes; never falsely matches a real contract | CI / free-tier host         |
| **set**              | `dockerBuildExecutor` — real hermetic Soroban build in the image                           | a Docker-equipped build box |

## Running the REAL Docker build

Real Rust/Soroban builds can't run in CI or on the free-tier host — they need
Docker + a pinned toolchain image. Here's the full local runbook.

### 1. Build the toolchain image (once)

From the **repo root**:

```sh
docker build -f infra/docker/verification-builder.Dockerfile -t vela-verify:1.94.0 .
```

The image pins Rust 1.94.0 + the `wasm32v1-none` target + Stellar CLI 26.1.0 to
match `contracts/rust-toolchain.toml` and `contracts/Cargo.toml`. **Those pins
are the reproducibility contract** — changing them changes output hashes.

### 2. Start the backend + a Postgres

The worker needs the same `DATABASE_URL` as `verification-service`. Locally:

```sh
docker compose -f infra/docker/docker-compose.yml up -d   # Postgres on :5433
# start the API side (gateway + verification-service) however you run the backend,
# e.g. the combined process:
pnpm --filter @vellar/all-in-one start
```

### 3. Start the worker pointed at the image

```sh
DATABASE_URL=postgres://vela:vela@localhost:5433/vela \
VERIFY_BUILD_IMAGE=vela-verify:1.94.0 \
STELLAR_RPC_URL=https://soroban-testnet.stellar.org \
pnpm --filter @vellar/worker-service start
```

On boot it logs `using the Docker build executor (image=vela-verify:1.94.0)`.
(Without `VERIFY_BUILD_IMAGE` it logs the STUB warning instead.)

### 4. Submit a contract for verification

Through the gateway (`:4000` by default):

```sh
curl -sX POST http://localhost:4000/verification/submit \
  -H 'content-type: application/json' \
  -d '{
    "contractId": "C...",                     // the DEPLOYED contract address
    "sourceType": "repo",
    "repoUrl": "https://github.com/org/contract",
    "commitHash": "<full-or-short-sha>",
    "toolchainVersion": "1.94.0",
    "buildFlags": []
  }'
```

Or use the web app: **/verify → Submit for verification**.

### 5. Watch it verify

```sh
curl -s http://localhost:4000/verification/C.../status
# → {"status":"submitted"}  then  "building"  then  "verified" | "failed"
```

`verified` means the rebuilt wasm hash is byte-for-byte the deployed one. The
full record (`GET /verification/C...`) carries both hashes and the build log.

## Reproducibility model: the container is the source of truth

Rust/Soroban wasm builds are **not bit-identical across build hosts** (LTO/codegen
makes different valid choices on macOS vs Linux vs a different CLI git build),
even with pinned toolchain + lockfile + profile. We proved this concretely:
a macOS-local build of our spending-limit contract and a Linux-container build
of the SAME source produce semantically-identical but byte-different wasm
(docs/decisions.md 2026-07-20).

So verification uses a **canonical build environment**: the image below is
internally deterministic (two clean builds are byte-identical), and **the
deployed on-chain artifact IS the image's output**. The rule:

> **Any contract we want to be verifiable MUST be built AND deployed through the
> canonical image — never from a developer's local host.**

Deploying a contract for verification is therefore:

```sh
# 1. build in the canonical image (deterministic)
docker run --rm -v "$(pwd)/contracts:/work" -w /work vela-verify:1.94.0 \
  stellar contract build
# 2. upload THOSE EXACT bytes (never re-optimize — build already optimized)
stellar contract upload \
  --wasm contracts/target/wasm32v1-none/release/<name>.wasm \
  --optimize=false \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  --source-account <funded-identity>
```

`--optimize=false` is REQUIRED: `stellar contract build` already optimizes, so
the verifier hashes the optimized bytes; re-optimizing on upload would change the
hash. Our spending-limit contract verifies byte-for-byte this way
(`0f6b858d…`, tx `6f83e098…`).

## RPC timeout and fallback (issue #330)

Resolving the deployed wasm hash reads from the configured Soroban RPC
endpoint (`STELLAR_RPC_URL`) via `getContractData` — a third-party dependency
outside this service's control. That call is bounded by `VERIFY_RPC_TIMEOUT_MS`
(default 10s); previously it had **no timeout at all**, so a hung RPC endpoint
could stall a worker job indefinitely.

A timeout is treated as **transient, not a verdict**: it does NOT produce a
terminal `failed` outcome (a contract that is perfectly valid must never be
permanently marked unverifiable just because one RPC call was slow). Instead
the job is left in `building` and picked up again on the worker's normal
retry path (`VERIFY_MAX_ATTEMPTS`, same reclaim/backoff/dead-letter mechanism
an unexpected error already uses) — see `runWorkerTick` in `src/loop.ts`.

This is deliberately different from a genuine RPC error (`rpc_error`, e.g. a
malformed response) or a real not-found (`not_found`) — both of those DO
still return a terminal `failed` outcome, since retrying them would not
change the answer.

## Reaper jitter (issue #331)

The reaper (M7, above — reclaims stranded `building` rows) previously ran on
a fixed `setInterval(runReaper, reapIntervalMs)`. In a horizontally-scaled
deploy, every replica boots within the same short window (most obviously
right after a rolling deploy) and would then sweep at the same wall-clock
moments forever after — a routine reclaim query turning into a synchronized
spike against Postgres on every tick.

The reaper now reschedules itself with `setTimeout` after each run, drawing a
fresh randomized delay via `jitteredDelayMs(reapIntervalMs, reapJitterMs)`
(`src/jitter.ts`) each time — `reapJitterMs` is an ABSOLUTE ± bound (not a
percentage), default 30s against the 5-min default interval. Set
`VERIFY_REAP_JITTER_MS=0` to disable jitter and restore the old fixed-interval
behavior exactly.

## Honest limitations (Phase 7 hardening)

- **Third-party contracts** are verifiable only when the author built with a
  matching toolchain. A metadata-tolerant comparison (normalize the
  `contractmetav0` `rsver`/`rssdkver`/`cliver` stamp) would widen this — a Phase 7
  nice-to-have, no longer a blocker for OUR contracts.
- The Docker build runs with **`--network=none`** (hermetic — no mid-build
  fetches, required for determinism). A repo whose dependencies aren't vendored
  or pre-fetched will fail the build under network isolation. Vendoring /
  lockfile-pinned dependency pre-fetch is Phase 7 work.
- A multi-contract workspace emits several wasms; such submissions must set
  `expectedWasmPath` to disambiguate (the resolver refuses to guess).

## Build sandbox (§8.4)

Builds run UNTRUSTED, submitter-provided code, so `docker run` is locked down:
`--network=none` (hermetic, no exfiltration), `--memory`/`--cpus`/`--pids-limit`
(resource + fork-bomb caps), `--read-only` root FS with a writable `--tmpfs /tmp`,
`--cap-drop=ALL`, `--security-opt no-new-privileges`, `--user 1000:1000`
(non-root) — plus an enforced build timeout that SIGKILLs a hung build. All caps
are env-tunable (see below). **Signed job payloads are intentionally not
implemented** — there is no untrusted queue between the service and the worker
(the shared Postgres is the trust boundary); see docs/decisions.md.

## Consumer group topology (issue #354)

The worker-service now uses **domain-specific consumer groups** for queue processing.
Each consumer group:

- Has its own dedicated job store, so groups never compete for the same queue
- Scales independently via configurable concurrency
- Runs in isolated worker loops with independent polling
- Shares common execution machinery (Executor, Resolver)

### Current groups

**Verification group** (`verification`):
- Processes contract verification jobs from the `verification_records` table
- Handles artifact download, WASM verification, attestation submission
- Concurrency controlled by `WORKER_CONCURRENCY` (default: 1)
- Each worker instance polls and claims its own batch

### Scaling a consumer group

To run more parallel verification workers, increase concurrency:

```sh
WORKER_CONCURRENCY=4 pnpm --filter @vellar/worker-service start
```

This spawns 4 independent worker loops, each claiming and processing verification
jobs concurrently. With a batch size of N, total throughput = concurrency × N.

### Adding new consumer groups

Future domains (e.g., transaction processing) can be added by:

1. Defining a new store interface (e.g., `TransactionJobStore`)
2. Adding a factory function in `consumer-groups.ts` (e.g., `createTransactionGroup`)
3. Starting the group in `index.ts` with its own store and concurrency settings

The architecture ensures groups remain isolated — a verification worker will never
process transaction jobs and vice versa.

## Env

| Var                       | Purpose                                                        | Default |
| ------------------------- | -------------------------------------------------------------- | ------- |
| `DATABASE_URL`            | shared verification store (REQUIRED — worker exits without it) | —       |
| `VERIFY_BUILD_IMAGE`      | toolchain image → real Docker builds; unset → stub             | unset   |
| `STELLAR_RPC_URL`         | RPC for reading the deployed wasm hash                         | testnet |
| `VERIFY_RPC_TIMEOUT_MS`   | cap on the RPC round-trip; a timeout is retried, not failed     | 10000   |
| `VERIFY_POLL_IDLE_MS`     | poll interval when the queue is idle                           | 5000    |
| `VERIFY_BUILD_TIMEOUT_S`  | kill a build after this many seconds                           | 600     |
| `VERIFY_BUILD_MEMORY`     | container memory cap (docker `--memory`)                       | 2g      |
| `VERIFY_BUILD_CPUS`       | container CPU cap (docker `--cpus`)                            | 2       |
| `VERIFY_BUILD_PIDS_LIMIT` | max processes in the container                                 | 512     |
| `WORKER_CONCURRENCY`      | parallel worker loops in the verification consumer group       | 1       |
| `VERIFY_REAP_JITTER_MS`   | ± randomized jitter on the reaper interval (0 disables it)     | 30000   |
