# Lifecycle-Service Audit Log PII Inventory and Redaction Policy

**Issue:** #342  
**Branch:** feat/audit-log-pii-redaction  
**Date:** 2026-08-29

## Summary

Lifecycle-service audit logs currently expose personally identifiable information (PII) including raw Stellar account identifiers, destination addresses, asset issuer addresses, managed data keys, and offer details. This document inventories every field logged by each endpoint and specifies the redaction strategy applied before persistence or shipment.

## Audit Log Call Sites Inventory

### Endpoint: POST /lifecycle/inspect
**Purpose:** Inspect a classic account's state (balances, offers, data entries)  
**Trigger:** User requests account inspection  
**Logged Data:** Full HorizonAccount object including accountId, all balances, all offers, all data keys

**Fields Logged (Current):**
| Field | Type | Value Example | PII Classification |
|-------|------|----------------|-------------------|
| `account.accountId` | string | `"GXXXXX...XXXXX"` | **RAW PII** — Unique account identifier |
| `account.sequence` | string | `"12345"` | Operational — Transaction sequence |
| `account.balances[].assetType` | string | `"native"` or `"credit_alphanum4"` | Operational — Asset type category |
| `account.balances[].assetCode` | string? | `"USDC"` | Operational — Public asset code (non-PII if from public ledger) |
| `account.balances[].assetIssuer` | string? | `"GXXXXX...XXXXX"` | **RAW PII** — Issuer account identifier |
| `account.balances[].balance` | string | `"1000.5000000"` | **SENSITIVE** — User's balance information |
| `account.dataKeys` | string[] | `["user_id", "profile_data"]` | **RAW PII** — User-defined data keys |
| `account.offers` | HorizonOffer[] | (see below) | **RAW PII** — User's DEX activity |
| `account.offers[].id` | string | `"123456789"` | **SENSITIVE** — Specific offer identifier |
| `account.offers[].sellingAssetIssuer` | string? | `"GXXXXX...XXXXX"` | **RAW PII** — Counterparty account |
| `account.offers[].buyingAssetIssuer` | string? | `"GXXXXX...XXXXX"` | **RAW PII** — Counterparty account |
| `account.offers[].price` | string | `"2.5"` | **SENSITIVE** — User's offer pricing |

### Endpoint: POST /lifecycle/plan
**Purpose:** Build a cleanup plan (identify blockers preventing account closure)  
**Trigger:** User requests cleanup plan  
**Logged Data:** CleanupPlan object with accountId, destination, detailed blockers

**Fields Logged (Current):**
| Field | Type | Value Example | PII Classification |
|-------|------|----------------|-------------------|
| `plan.accountId` | string | `"GXXXXX...XXXXX"` | **RAW PII** — Source account to close |
| `plan.destination` | string | `"GXXXXX...XXXXX"` | **RAW PII** — Receiving account for XLM |
| `plan.blockers[].type` | string | `"balance"`, `"trustline"`, `"offer"`, `"data"` | Operational — Blocker category |
| `plan.blockers[].description` | string | `"Holds 100.5 USDC"` | **SENSITIVE** — Reveals balances and asset holdings |
| `plan.blockers[].actionRequired` | string | `"Transfer or burn the USDC balance..."` | **SENSITIVE** — User action guidance (reveals what they hold) |
| `plan.estimatedTransactions` | number | `5` | Operational — Cleanup complexity indicator |
| `plan.mergeReady` | boolean | `false` | Operational — Status flag |

### Endpoint: POST /lifecycle/execute
**Purpose:** Build unsigned cleanup transactions  
**Trigger:** User requests transaction preparation  
**Logged Data:** Array of CleanupStep objects + CleanupPlan (same as /plan)

**Fields Logged (Current):**
| Field | Type | Value Example | PII Classification |
|-------|------|----------------|-------------------|
| `steps[].title` | string | `"Clean up the account (1/3)"` | Operational — User-facing step label |
| `steps[].description` | string | `"Transaction 1 of 3 — sign and submit in order..."` | Operational — Instruction text |
| `steps[].xdr` | string | (base64 transaction envelope) | **SENSITIVE** — Full transaction data (contains account IDs, operations) |
| `steps[].hash` | string | (hex transaction hash) | Operational — Deterministic hash for tracking |
| `plan.*` | (see /plan above) | — | Same as /plan endpoint |

### Endpoint: POST /lifecycle/merge
**Purpose:** Build final account-merge transaction (only when all blockers cleared)  
**Trigger:** User confirms merge  
**Logged Data:** Single CleanupStep (merge transaction)

**Fields Logged (Current):**
| Field | Type | Value Example | PII Classification |
|-------|------|----------------|-------------------|
| `step.title` | string | `"Merge and close the account"` | Operational — User-facing step label |
| `step.description` | string | `"Closes GXXXXX... and sends entire XLM..."` | **SENSITIVE** — Contains raw account IDs |
| `step.xdr` | string | (base64 transaction envelope) | **SENSITIVE** — Full transaction data (contains account IDs) |
| `step.hash` | string | (hex transaction hash) | Operational — Deterministic hash for tracking |

## Redaction Classification and Strategy

### Category 1: Raw PII — DROP Entirely
These fields directly identify users and have no legitimate audit value. They are dropped completely.

**Fields:**
- `accountId` — Unique Stellar account identifier
- `destination` — Receiving account identifier
- `assetIssuer` — Counterparty account identifiers
- `dataKeys` — User-defined data entry names
- `offers` — Full offer details (IDs, counterparties, pricing)
- `blockers[].description` — Natural-language descriptions containing balances and holdings
- `blockers[].actionRequired` — Action guidance revealing what user holds
- Step `description` — Contains raw account IDs in user-facing text

**Rationale:** These fields expose the user's identity and activity. They are not needed for audit log usefulness — operators can correlate entries by hashed account references and deterministic transaction hashes.

### Category 2: Retained-But-Sensitive — HASH with Consistent Salt
These fields are useful for audit correlation (e.g., tracking all operations for a single account) but must not expose raw values. We hash them with a consistent, server-controlled salt so the same input always produces the same hash (deterministic), enabling correlation without exposing PII.

**Fields and Transformation:**
- `accountId` → `accountRef: SHA256(accountId || salt).substring(0, 12)`
  - Enables correlation: "All events for accountRef=abc123d456e7 are linked"
  - Prevents recovery: Hash is one-way; raw account cannot be derived
  - Example: `GXXXXX...XXXXX` → `5f3a2b1c4d9e`

- `destination` → `destinationRef: SHA256(destination || salt).substring(0, 12)`
  - Same rationale as accountId

- `assetIssuer` (in plan blockers) → `issuerRef: SHA256(issuer || salt).substring(0, 12)`
  - Allows tracking: "User was interacting with asset from issuer hash=xyz..."
  - Prevents tracking individuals: Cannot link issuer hash back to the original account

- `dataKeys` (count preserved) → `dataKeyCount: length of dataKeys array`
  - Keeps operational value: "Account had N data entries to clean"
  - Hides identity: Does not expose actual key names

**Salt Generation:**
- The salt is generated once per service instance and remains constant for the lifetime of the service
- This ensures consistent hashing: `SHA256(value || salt)` always produces the same hash for the same value
- The salt is NOT shared externally and NOT logged; it is internal to the redaction function
- Salt is generated from `crypto.randomBytes(32).toString('hex')` at service startup

**Hash Output Length:**
- Truncated to 12 hexadecimal characters (48 bits) — sufficient to prevent accidental collisions for audit correlation without encoding the full hash length

### Category 3: Operational Non-PII — KEEP As-Is
These fields contain no PII and are necessary for audit trail usefulness. They are logged without modification.

**Fields:**
- `sequence` — Transaction sequence number (operational state, not identifying)
- `balances` (array count only) → `balanceCount: number`
  - Kept: Operational indicator of account complexity
  - Modified: We log the count, not the individual balances with issuers
- `blockers` (types only) → `blockerTypes: string[]` (e.g., `["balance", "trustline", "offer", "data"]`)
  - Kept: Indicates what kind of cleanup is needed
  - Modified: We log the types, not the descriptions containing sensitive data
- `openOffers` (count only) → Preserved as-is
  - Operational: Indicates DEX activity complexity
- `dataKeys` (count only) → Preserved as-is (see above, `dataKeyCount`)
- `step.hash` — Transaction hash
  - Kept: Deterministic from public data; useful for tracking and replay detection
  - Not an identifier of the user; the hash is the same regardless of who signed
- `step.title` — Generic step titles like `"Clean up the account (1/3)"`
  - Kept: No PII; operational guidance
- `estimatedTransactions` — Complexity metric
  - Kept: No PII; operational

### Transaction XDR (Signed Transactions)
**Decision:** DROP entirely from audit logs.

**Rationale:**
- Transaction XDR envelope contains full operation details including source account, destination, asset issuers, amounts — all PII
- The transaction hash is deterministic and already captured separately (sufficient for tracking and replay detection)
- Including the full XDR exposes more PII than hashing can reasonably handle at audit-log time
- If auditors need to review transactions, they should retrieve them from the blockchain directly (public Horizon API), not from internal audit logs

---

## Redaction Implementation

### Centralized Wrapper Function

All audit logging goes through a single `redactAuditEvent()` function. This ensures:
1. **Consistency:** All PII redaction follows the same rules
2. **Single Point of Control:** A future contributor reviewing audit logging can find the redaction logic in one place
3. **Structural Safety:** It is structurally difficult to bypass — all audit calls must pass through the same wrapper, making it hard to accidentally log unredacted data

### Function Signature

```typescript
/**
 * Redacts PII from a lifecycle-service audit event before persistence.
 * 
 * Applies consistent redaction rules:
 * - Raw PII (account IDs, data keys, offers) are dropped entirely
 * - Sensitive fields needed for correlation (accounts, destinations) are SHA256-hashed with a service-level salt
 * - Operational fields (counts, types, hashes) are preserved as-is
 * 
 * The same input always produces the same redacted output (deterministic hashing),
 * enabling correlation across audit entries without exposing raw PII.
 * 
 * @param event - The audit event before redaction
 * @returns Redacted audit event safe for persistence and external shipment
 */
export function redactAuditEvent(event: AuditEvent): AuditEvent
```

### Redaction Rules Applied (Pseudocode)

```
For each audit event:
  1. Drop: event.data.account (entire HorizonAccount object)
  2. Drop: event.data.plan.blockers[].description
  3. Drop: event.data.plan.blockers[].actionRequired
  4. Drop: event.data.steps[].xdr (transaction envelope)
  5. Drop: event.data.step.xdr (transaction envelope)
  6. Drop: event.data.step.description (if it contains raw account IDs)
  7. Hash: event.data.plan.accountId → redactedEvent.data.plan.accountRef
  8. Hash: event.data.plan.destination → redactedEvent.data.plan.destinationRef
  9. Preserve: event.data.steps[].hash
  10. Preserve: event.data.step.hash
  11. Preserve: event.data.plan.estimatedTransactions
  12. Preserve: event.data.plan.mergeReady
  13. Count: event.data.blockers → event.data.blockerTypes and event.data.blockerCount
```

---

## Testing Strategy

### Test 1: Complete Field Redaction for Each Endpoint
For every field classified as "DROP", verify it does not appear in the redacted audit log output:
- `accountId` never appears in `redactedEvent.data`
- `destination` never appears in plain text
- `blockers[].description` never appears
- `step.xdr` never appears
- `account` object never appears

### Test 2: Deterministic Hashing for Correlation
Verify that the same input always produces the same hash:
- Two redacted events for the same account hash to the same `accountRef`
- Two redacted events for different accounts hash to different `accountRef` values
- A human cannot reverse the hash to recover the original account ID

### Test 3: Operational Field Preservation
Verify operational fields are unchanged:
- `step.hash` is preserved exactly
- `plan.estimatedTransactions` is preserved
- `blockerTypes` list is correct (e.g., `["balance", "trustline"]` for an account with those blockers)
- `balanceCount` reflects the correct count

### Test 4: Structural Bypass Prevention
Verify that all audit log call sites go through the redaction wrapper:
- If a new endpoint calls `audit.record()` without passing through `redactAuditEvent()`, the test should detect it
- This is enforced by either:
  - All `audit.record()` calls being wrapped in a lifecycle-service-specific wrapper
  - OR a pre-persistence hook in the AuditLog interface that applies redaction automatically
  - OR a type-level constraint that forces redaction

---

## Future Contributor Guidance

### When Adding a New Audit Log Event

1. **Identify the data you want to log:** Collect it from your endpoint response
2. **Classify each field:**
   - Is it an identifier of a user/account/wallet? → Likely PII
   - Is it a user's personal data (balance, holdings, offers)? → PII
   - Is it a count, type, hash, or status flag? → Likely operational
   - Consult the classification table above for examples
3. **Update `redactAuditEvent()`:** Add redaction rules for any new fields
4. **Add tests:** For each new field, add a test asserting it is either redacted or preserved as intended
5. **Update this document:** Add the new event type to the inventory above

### Red Flags (Do Not Log Without Redaction)

- Raw Stellar account IDs (G... addresses)
- Private keys or signatures (should never be logged anyway)
- User-provided data (unless it's already public — e.g., a data key name should be hashed)
- Asset issuer addresses (unless specifically needed and hashed)
- Transaction amounts (potential PII; use counts/types instead)
- Full transaction XDR (too much PII; use hashes instead)

---

## Compliance Checklist

- [x] All PII fields in lifecycle-service audit logs identified
- [x] Each field classified: drop, hash, or keep
- [x] Rationale documented for each classification
- [x] Centralized redaction wrapper designed
- [x] Consistent hashing with service-level salt specified
- [x] Testing strategy defined
- [x] Future contributor guidance provided

---

## Appendix: Example Audit Events

### Before Redaction (POST /lifecycle/plan)
```json
{
  "type": "lifecycle.plan_requested",
  "at": "2026-08-29T14:30:00Z",
  "data": {
    "plan": {
      "accountId": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      "destination": "GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY",
      "blockers": [
        {
          "type": "balance",
          "description": "Holds 1000.5 USDC from issuer GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
          "actionRequired": "Transfer or burn the USDC balance before removing its trustline"
        }
      ],
      "estimatedTransactions": 2,
      "mergeReady": false
    }
  }
}
```

### After Redaction (POST /lifecycle/plan)
```json
{
  "type": "lifecycle.plan_requested",
  "at": "2026-08-29T14:30:00Z",
  "data": {
    "plan": {
      "accountRef": "5f3a2b1c4d9e",
      "destinationRef": "7a8b9c0d1e2f",
      "blockerTypes": ["balance"],
      "blockerCount": 1,
      "estimatedTransactions": 2,
      "mergeReady": false
    }
  }
}
```

**Note:** `description` and `actionRequired` are dropped entirely. Account IDs are replaced with hashes. `blockers` is summarized by type and count only.

---

## References

- Issue: #342 — PII Redaction in Audit Logs
- Branch: feat/audit-log-pii-redaction
- Vault Wallet Repository: vellar-dapp
- Related: wallet-service audit logging (session.revoked uses similar hashing approach)
