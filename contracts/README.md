# Contracts

Soroban (Rust) smart contracts for VELA. See technical-doc.md §11 and idea.md §10.

- `smart-account/` — passkey-backed smart account with policy enforcement and modular authorization logic. Built in Phase 2 (wallet core needs it for passkey wallets).
- `policy-templates/` — generated/templated policy contracts: signer threshold checks, spend limits, contract allowlists, delayed admin actions. Built in Phase 5.

Scaffold each with `stellar contract init` when its phase begins; keep a single Cargo workspace at this level once the first contract exists.

Security checklist before any mainnet deploy (idea.md §12): authorization correctness, initialization guards, storage safety, checked arithmetic, contract call restrictions, TTL/state persistence handling.
