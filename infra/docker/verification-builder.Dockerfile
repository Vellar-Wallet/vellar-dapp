# Deterministic Soroban build image for contract verification (worker-service).
#
# This is the toolchain `dockerBuildExecutor` shells into: it must reproduce a
# submitted contract's wasm byte-for-byte, so every version here is PINNED to
# match what our contracts are built with (contracts/rust-toolchain.toml +
# contracts/Cargo.toml). Bumping any pin changes output hashes — treat this file
# as part of the reproducibility contract and re-verify known contracts after
# any change.
#
# Build (from the repo root):
#   docker build -f infra/docker/verification-builder.Dockerfile \
#     -t vela-verify:1.94.0 .
#
# The executor runs, per source:
#   docker run --rm --network=none -v <repo>:/work -w /work <image> \
#     stellar contract build
# so the image's default user must be able to build under /work, and `stellar`
# + `cargo` must be on PATH.

# Pinned Rust matching contracts/rust-toolchain.toml (channel 1.94.0).
FROM rust:1.94.0-bookworm

# --- Pins (keep in lockstep with the contract workspace) ---------------------
# Stellar CLI version — matches the local toolchain that produced the deployed
# wasm (stellar 26.1.0). The CLI drives `stellar contract build`.
ARG STELLAR_CLI_VERSION=26.1.0
# The wasm target the contracts compile to (contracts/rust-toolchain.toml).
ARG WASM_TARGET=wasm32v1-none

# System deps for building the contracts + fetching the CLI.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     pkg-config libssl-dev libdbus-1-dev git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# The wasm target + rustfmt/clippy the contract toolchain declares.
RUN rustup target add ${WASM_TARGET} \
  && rustup component add rustfmt clippy rust-src

# Install the pinned Stellar CLI from the official PREBUILT release binary.
# (Compiling stellar-cli from source needs several GB of RAM and can OOM in a
# constrained builder; the prebuilt binary is lighter, faster, and identical
# every time — better for reproducibility than a from-source compile.) The
# asset arch is derived from the build platform so amd64 and arm64 both work.
RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    arm64) triple="aarch64-unknown-linux-gnu" ;; \
    amd64) triple="x86_64-unknown-linux-gnu" ;; \
    *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
  esac; \
  url="https://github.com/stellar/stellar-cli/releases/download/v${STELLAR_CLI_VERSION}/stellar-cli-${STELLAR_CLI_VERSION}-${triple}.tar.gz"; \
  curl -fsSL "$url" -o /tmp/stellar-cli.tar.gz; \
  tar -xzf /tmp/stellar-cli.tar.gz -C /usr/local/bin stellar; \
  rm /tmp/stellar-cli.tar.gz; \
  chmod +x /usr/local/bin/stellar

# Sanity: fail the image build if the toolchain isn't what we expect, so a
# broken image never silently produces wrong hashes.
RUN rustc --version && stellar --version && rustup target list --installed | grep -q ${WASM_TARGET}

# The executor mounts the cloned repo at /work and builds there.
WORKDIR /work

# Default command is a no-op; the executor always supplies
# `stellar contract build [...]`.
CMD ["stellar", "--version"]
