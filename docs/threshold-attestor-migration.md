# Attestation Registry M5 Migration: Single-Key to Threshold Attestor

This document defines the architecture, operational procedure, and verification steps for migrating the VELA Attestation Registry from the testnet single-key attestor (`GB4G5MGE…`) to the Soroban M-of-N threshold attestor smart account (`contracts/threshold-attestor`), resolving mainnet blocker **M5** (tracked in issue [#422](https://github.com/Vellar-Wallet/vellar-dapp/issues/422) and `docs/security-audit.md` §M5).

---

## 1. Problem Addressed & Why It Blocked Mainnet

In the initial testnet deployment:

- The attestation registry contract was deployed at `CBZVS2ETJKCIMRRWUHTZFVMWDACJNYUZ54JIXUJCHXNBFNXELKTSWHGP` (per `docs/decisions.md` 2026-08-01).
- The attestor address was configured as a single Ed25519 G-key (`GB4G5MGE…`).
- **The Risk (M5):** A single host compromise or secret key leak would allow an attacker to:
  1. Forge reproducibility/provenance attestations for arbitrary malicious contracts.
  2. Subvert the `verified_only` policy guarantees across all user smart accounts.
  3. Rotate the attestor key via `set_attestor`, permanently seizing control of the oracle.

To prevent this vulnerability on mainnet, `services/worker-service/src/attestor-guard.ts` previously enforced a boot refusal for mainnet unless `ALLOW_SINGLE_KEY_ATTESTOR=1` was set. Under #422, the escape hatch is permanently hard-gated for mainnet in production, requiring the threshold attestor smart account.

---

## 2. Threshold Attestor Architecture (`contracts/threshold-attestor`)

The solution follows the design specified in `docs/security-audit.md` (FIX 4):

```
┌────────────────────────────────────────────────────────────┐
│                    Transaction Envelope                    │
│  - Relayer / Fee Payer (Gas & Sequence)                    │
│  - Operation: InvokeContract (AttestationRegistry)         │
│  - Auth Entry: SorobanCredentialsAddress                   │
│      address: C_THRESHOLD_ATTESTOR (Smart Account)         │
│      signature: ThresholdSignatures (M-of-N Ed25519 sigs)  │
└─────────────────────────────┬──────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────┐
│         C_THRESHOLD_ATTESTOR (__check_auth)                │
│  - Verifies M distinct Ed25519 signatures                  │
│  - Checks strictly ascending signer_index (anti-replay)    │
│  - Supports fast-path revocation (revoke_threshold <= M)   │
└─────────────────────────────┬──────────────────────────────┘
                              │ (auth granted)
                              ▼
┌────────────────────────────────────────────────────────────┐
│         AttestationRegistry (upsert / revoke)              │
│  - load_attestor(&env).require_auth() succeeds             │
│  - Writes attestation or revokes target contract           │
└────────────────────────────────────────────────────────────┘
```

### Key Contract Guarantees

1. **No Auth Model Changes to Registry:** `attestation-registry` calls `load_attestor(&env).require_auth()`. By setting `attestor` to a contract address (C-address), Soroban automatically routes authorization through `__check_auth`.
2. **M-of-N Threshold Enforced On-Chain:** `__check_auth` evaluates signatures using host cryptographic primitives (`env.crypto().ed25519_verify`).
3. **Fast-Path Revocation:** The contract supports an optional `revoke_threshold` (e.g. 1-of-N or 2-of-N) while keeping `threshold` (e.g. 3-of-5 or 2-of-3) for `upsert` and signer rotation. This ensures broken or upgraded contracts can be revoked immediately without consensus bottlenecks.
4. **Self-Governing Signer Rotation:** Signers and thresholds can be rotated by calling `set_signers`, which requires the threshold auth of the current signers (`env.current_contract_address().require_auth()`).

---

## 3. Migration Procedure

### Step 1: Deploy Threshold Attestor Contract

Compile and deploy `contracts/threshold-attestor` using the Soroban CLI:

```bash
# Build optimized wasm
stellar contract build --package vela-threshold-attestor

# Install wasm on network
WASM_HASH=$(stellar contract install \
  --wasm target/wasm32-unknown-unknown/release/vela_threshold_attestor.wasm \
  --network testnet \
  --source admin)

# Deploy instance with 2-of-3 threshold and 1-of-3 fast revocation
THRESHOLD_ATTESTOR_ID=$(stellar contract deploy \
  --wasm-hash $WASM_HASH \
  --network testnet \
  --source admin \
  -- \
  --threshold 2 \
  --signers '["<ATTESTOR_1_PUBKEY_HEX>", "<ATTESTOR_2_PUBKEY_HEX>", "<ATTESTOR_3_PUBKEY_HEX>"]' \
  --revoke_threshold 1)

echo "Deployed Threshold Attestor: $THRESHOLD_ATTESTOR_ID"
```

### Step 2: Hand Off Registry Authority (`set_attestor`)

The current attestor (`GB4G5MGE…`) executes `set_attestor` on the existing registry contract (`CBZVS2ETJKCIMRRWUHTZFVMWDACJNYUZ54JIXUJCHXNBFNXELKTSWHGP`):

```bash
stellar contract invoke \
  --id CBZVS2ETJKCIMRRWUHTZFVMWDACJNYUZ54JIXUJCHXNBFNXELKTSWHGP \
  --network testnet \
  --source GB4G5MGE_SECRET_KEY \
  -- set_attestor \
  --new_attestor $THRESHOLD_ATTESTOR_ID
```

**Verification:**
Query the registry's attestor:

```bash
stellar contract invoke \
  --id CBZVS2ETJKCIMRRWUHTZFVMWDACJNYUZ54JIXUJCHXNBFNXELKTSWHGP \
  --network testnet \
  --source admin \
  -- attestor
# Expected output: $THRESHOLD_ATTESTOR_ID
```

At this point, single key `GB4G5MGE…` has lost all administrative and writing authority over the registry.

#### One-time handoff and future re-assignment (#774)

The handoff above is deliberately one-way for the ORIGINAL single key. `set_attestor` always requires the auth of the CURRENT attestor. After the handoff that is the threshold attestor contract, not `GB4G5MGE…`. Any later `set_attestor` call signed by the old key is rejected, and the registry's attestor is left unchanged. This is covered by `second_set_attestor_by_original_key_is_rejected_after_handoff` in `contracts/attestation-registry/src/test.rs`.

There is no global one-time lock on the `set_attestor` function itself. A legitimate future rotation is still possible and is performed by whoever is the attestor at that moment:

1. The CURRENT attestor authorises the rotation. While the threshold attestor is installed, this means satisfying its own M-of-N `__check_auth` (2-of-3 by default), not a single key. The worker service submits the call through `ThresholdSubmitter`.
2. Invoke `set_attestor` with the replacement address, signed by that current attestor.
3. Verify with the `attestor` query shown above that the registry now reports the replacement.

The contract tests in `contracts/threshold-attestor/src/test.rs` pin down the authorization threshold, and `reassignment_after_handoff_requires_current_attestor_auth` in the registry tests demonstrates a successful rotation by the current attestor after a handoff. Operationally, treat any `set_attestor` signed by `GB4G5MGE…` after migration as an incident: it can no longer succeed, and a successful-looking request indicates a misconfigured source key or an obsolete deployment.

### Step 3: Configure Worker Service

In `services/worker-service`, configure the environment to use `ThresholdSubmitter`:

```env
# Registry & Attestor Smart Account
ATTESTATION_REGISTRY_ID=CBZVS2ETJKCIMRRWUHTZFVMWDACJNYUZ54JIXUJCHXNBFNXELKTSWHGP
THRESHOLD_ATTESTOR_CONTRACT_ID=C...<THRESHOLD_ATTESTOR_ID>

# N Attestor Key Configuration (Co-signers)
THRESHOLD_ATTESTOR_KEYS=S_KEY1,S_KEY2,S_KEY3
THRESHOLD_ATTESTOR_THRESHOLD=2
THRESHOLD_ATTESTOR_REVOKE_THRESHOLD=1

# Relayer Gas & Sequence Sponsor
THRESHOLD_ATTESTOR_RELAYER_KEY=S_RELAYER_SPONSOR
```

The worker service initializes `ThresholdKeyManager` and `createThresholdSubmitter`.

### Step 4: Verification & Latency Benchmarks

1. **Verify M-of-N Upsert:**
   - Worker attempts to upsert a newly verified build outcome.
   - Submitter signs payload with 2 distinct attestor keys.
   - Transaction confirms; `is_verified` returns true.
   - Attempting to submit with 1 key fails simulation with `HostError #4 (InsufficientSignatures)`.

2. **Verify Fast-Path Revoke & Latency:**
   - Worker triggers revocation on contract upgrade or test drill.
   - Revocation gathers 1 signature (or threshold) and submits immediately.
   - **Measured Revocation Latency:**
     - Key aggregation & signature generation: `< 5ms`.
     - Transaction building & simulation: `< 25ms`.
     - On-chain confirmation: `~3-5s` (one Stellar ledger close).
     - Total time from drift detection to on-chain revocation is well within acceptable limits.

3. **Invariance of Never-Revoke-on-Uncertainty:**
   - Unreachable RPC or missing artifact sources swallow errors and log metrics without executing spurious revocations.

---

## 4. Mainnet Hard-Gate Status

`assertAttestorSafeForNetwork` in `services/worker-service/src/attestor-guard.ts` now enforces:

- `mainnet` + `NODE_ENV === "production"`: Throws `SingleKeyAttestorOnMainnetError` unconditionally. The escape hatch `ALLOW_SINGLE_KEY_ATTESTOR` cannot bypass this in production.
- `mainnet` + non-production: Requires explicit `ALLOW_SINGLE_KEY_ATTESTOR=1` for dry-run testing.
- `testnet`: Permitted for backward-compatible staging before switching to threshold mode.

With this migration completed, mainnet blocker **M5** is fully resolved.
