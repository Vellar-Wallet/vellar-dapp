# @vela/worker-service

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
pnpm --filter @vela/all-in-one start
```

### 3. Start the worker pointed at the image

```sh
DATABASE_URL=postgres://vela:vela@localhost:5433/vela \
VERIFY_BUILD_IMAGE=vela-verify:1.94.0 \
STELLAR_RPC_URL=https://soroban-testnet.stellar.org \
pnpm --filter @vela/worker-service start
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

## Env

| Var                       | Purpose                                                        | Default |
| ------------------------- | -------------------------------------------------------------- | ------- |
| `DATABASE_URL`            | shared verification store (REQUIRED — worker exits without it) | —       |
| `VERIFY_BUILD_IMAGE`      | toolchain image → real Docker builds; unset → stub             | unset   |
| `STELLAR_RPC_URL`         | RPC for reading the deployed wasm hash                         | testnet |
| `VERIFY_POLL_IDLE_MS`     | poll interval when the queue is idle                           | 5000    |
| `VERIFY_BUILD_TIMEOUT_S`  | kill a build after this many seconds                           | 600     |
| `VERIFY_BUILD_MEMORY`     | container memory cap (docker `--memory`)                       | 2g      |
| `VERIFY_BUILD_CPUS`       | container CPU cap (docker `--cpus`)                            | 2       |
| `VERIFY_BUILD_PIDS_LIMIT` | max processes in the container                                 | 512     |
