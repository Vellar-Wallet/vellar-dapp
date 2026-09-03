# Contracts

Soroban (Rust) smart contracts for Vellar. See technical-doc.md §11 and idea.md §10.

- `smart-account/` — passkey-backed smart account with policy enforcement and modular authorization logic. Built in Phase 2 (wallet core needs it for passkey wallets).
- `policy-templates/` — generated/templated policy contracts: signer threshold checks, spend limits, contract allowlists, delayed admin actions. Built in Phase 5.

Scaffold each with `stellar contract init` when its phase begins; keep a single Cargo workspace at this level once the first contract exists.

## Supply-Chain Hardening & Security Checklist

To protect against dependency tampering and supply-chain attacks:

1. **Exact Version Pinning**: All dependencies in `contracts/Cargo.toml` must be pinned with exact versions (e.g. `soroban-sdk = "=27.0.0"`, `ed25519-dalek = "=2.2.0"`).
2. **Git Commit Hash Pinning**: Any git dependencies must be pinned to explicit 40-character SHA-1 commit hashes (e.g. `smart-wallet-interface`).
3. **Toolchain Pinning & Verification**: Rust toolchains in `contracts/rust-toolchain.toml` specify exact channel `1.94.0` and explicit target `wasm32v1-none`.
4. **CI Enforcement**: The CI pipeline includes an automated check verifying that no unpinned or floating dependency specifications exist in the contracts workspace.

Security checklist before any mainnet deploy (idea.md §12): authorization correctness, initialization guards, storage safety, checked arithmetic, contract call restrictions, TTL/state persistence handling.
