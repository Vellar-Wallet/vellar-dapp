# Merge Eligibility Reasons Mock Route

A self-contained mock route module for checking merge eligibility for accounts and returning structured reason codes when ineligible.

## Overview

This module provides a mock implementation of merge eligibility checks that returns structured reason codes explaining why an account cannot be merged. It's designed to be a standalone utility that can be tested and extended.

## Reason Codes

Reason codes are short, uppercase strings that identify why an account is ineligible for merging:

- `OPEN_TRUSTLINES` - Account has open trustlines that must be closed
- `PENDING_OFFERS` - Account has pending offers that must be resolved
- `ESCROW_ENTRIES` - Account has active escrow entries
- `CLAWBACK_ENABLED` - Account has clawback enabled on issued assets
- `SEQUENCE_MISMATCH` - Account sequence number indicates pending operations

## API

### `checkMergeEligibility(account: Account): EligibilityResult`

Checks if an account is eligible for merging.

**Parameters:**

- `account`: Account object with id, trustlines, offers, escrow, and clawback properties

**Returns:**

```typescript
{
  eligible: boolean;
  reasons: string[];  // Empty if eligible, populated with reason codes if not
}
```

## Usage

```typescript
import { checkMergeEligibility } from "./checker";

const account = {
  id: "G...",
  trustlines: [],
  offers: [],
  escrow: [],
  clawbackEnabled: false,
};

const result = checkMergeEligibility(account);
console.log(result);
// { eligible: true, reasons: [] }
```

## Sample Accounts

### Account 1: Eligible Account

```
ID: GAAA
- No open trustlines
- No pending offers
- No escrow entries
- Clawback disabled
Result: eligible = true, reasons = []
```

### Account 2: Ineligible Account

```
ID: GBBB
- 2 open trustlines
- 1 pending offer
- 1 escrow entry
Result: eligible = false, reasons = [
  'OPEN_TRUSTLINES',
  'PENDING_OFFERS',
  'ESCROW_ENTRIES'
]
```

## Running Tests

```bash
npm test
# or
pnpm test
```

This runs `test.ts` which validates both sample accounts produce expected results.
