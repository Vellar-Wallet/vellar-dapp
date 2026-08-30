# @vellar/policy-sdk

Policy client: authoring, validation, serialization, simulation, deployment helpers.

## Overview

This package provides the typed API surface for Vellar's programmable policy system. Third-party integrators import types and utilities from here; the actual HTTP client lives in `vellar-sdk`.

## Policy template types

| Type | Title | Enforcement |
|------|-------|-------------|
| `single_owner` | Single owner | None (default wallet state) |
| `multisig_threshold` | Multisig threshold | Smart wallet native SignerLimits |
| `spending_limit` | Spending limit | On-chain policy contract (rolling window) |
| `contract_allowlist` | Contract allowlist | Smart wallet native SignerLimits |
| `timelock` | Time-lock | Custom contract (pending) |
| `per_tx_cap` | Per-transaction cap | Custom contract (pending) |
| `recipient_allowlist` | Recipient allow/deny list | Smart wallet native SignerLimits |
| `never_sent_before` | Never-sent-before | Smart wallet native SignerLimits |

## Exports

### Types

- `PolicyTemplateType` — union of all known template type strings
- `Enforcement` — discriminated union of enforcement descriptors
- `SpendingConstructor` — immutable args for the spending-limit contract
- `PolicyTemplateInfo` — template metadata (type, title, description, enforcement)
- `GeneratedPolicy` — full policy record with definition, hash, and manifest
- `ValidationResult` — `{ valid, errors }` from definition validation
- `SimulateResult` — dry-run deploy result
- `DeployPolicyResult` — result of the full deploy flow
- `PolicyAttachRuntime` — runtime seam for passkey attach (web app provides)

### Functions

- `stroopsToXlm(stroops)` — convert a stroops string to an XLM decimal string
- `enforcementLabel(enforcement)` — human-readable label for an enforcement descriptor

### Constants

- `ENFORCEMENT_DESCRIPTIONS` — honest enforcement descriptions per template type, including coverage limitations

## Honest enforcement

Every template declares what is actually enforced on-chain. The `ENFORCEMENT_DESCRIPTIONS` map provides honest descriptions that must be shown to users before they deploy a policy. Key properties:

- **Spending limits** are cumulative rolling-window caps, not per-transaction caps
- **Signer-limits enforcement** covers the smart wallet's native mechanism
- **Custom-contract-pending** templates are not yet enforced on-chain
- All on-chain enforcement is limited to known transfer patterns (SEP-41 transfer operations)

## Usage

```typescript
import {
  type PolicyTemplateType,
  type Enforcement,
  type GeneratedPolicy,
  enforcementLabel,
  stroopsToXlm,
  ENFORCEMENT_DESCRIPTIONS,
} from "@vellar/policy-sdk";
```
