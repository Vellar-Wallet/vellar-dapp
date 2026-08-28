# Cleanup Plan Steps Mock Route

A self-contained mock route module that generates a cleanup plan for accounts, returning an ordered list of steps to resolve blockers.

## Overview

This module provides a mock implementation of cleanup planning that returns a structured set of steps an account owner must complete to resolve merge blockers. Steps are ordered and include type and description information.

## Step Types

Step types classify the action needed to resolve a blocker:

- `CLOSE_TRUSTLINE` - Close an open trustline
- `CANCEL_OFFER` - Cancel a pending offer
- `RELEASE_ESCROW` - Release an escrow entry
- `DISABLE_CLAWBACK` - Disable clawback on issued assets
- `VERIFY_SEQUENCE` - Verify and clear pending sequence operations
- `FINALIZE` - Final verification step before merge

## API

### `getCleanupPlan(accountId: string): CleanupPlan`

Retrieves the cleanup plan for an account.

**Parameters:**

- `accountId`: The account ID to get the cleanup plan for

**Returns:**

```typescript
{
  accountId: string;
  steps: Step[];
}

interface Step {
  order: number;
  type: string;
  description: string;
}
```

## Usage

```typescript
import { getCleanupPlan } from "./planner";

const plan = getCleanupPlan("GAAA...");
console.log(plan);
// {
//   accountId: 'GAAA...',
//   steps: [
//     { order: 1, type: 'CLOSE_TRUSTLINE', description: '...' },
//     { order: 2, type: 'CANCEL_OFFER', description: '...' },
//     { order: 3, type: 'FINALIZE', description: '...' }
//   ]
// }
```

## Sample Accounts

### Account 1: GAAA... (Simple cleanup)

- 1 open trustline to close
- 1 pending offer to cancel
- Final verification
- Total: 3 steps

### Account 2: GBBB... (Complex cleanup)

- 2 open trustlines to close
- 2 pending offers to cancel
- 1 escrow entry to release
- Clawback to disable
- Final verification
- Total: 6 steps

## Running Tests

```bash
npm test
# or
pnpm test
```

This runs `test.ts` which validates:

- Plans are returned for valid accounts
- Steps are ordered sequentially
- All steps are present for each account
