# Wallet Creation Handshake Mock Route

A self-contained mock route module simulating a two-step handshake for registering and confirming wallet creation.

## Overview

This module provides a mock implementation of a wallet creation flow with a two-step handshake:

1. **Register** - Initiates wallet creation and returns a pending wallet ID with a challenge
2. **Confirm** - Confirms wallet creation with the pending wallet ID

The handshake ensures that wallet creation follows a predictable, verifiable sequence.

## API

### Register Endpoint

**Function:** `registerWallet()`

Initiates wallet creation and returns a pending wallet ID with a challenge string.

**Returns:**

```typescript
{
  walletId: string;
  challenge: string;
  status: "pending";
}
```

**Example:**

```typescript
const registration = registerWallet();
// {
//   walletId: 'wallet_abc123def456',
//   challenge: 'challenge_xyz789',
//   status: 'pending'
// }
```

### Confirm Endpoint

**Function:** `confirmWallet(walletId: string): ConfirmResult`

Confirms wallet creation for the given pending wallet ID.

**Parameters:**

- `walletId`: The pending wallet ID from the register step

**Returns:**

```typescript
{
  walletId: string;
  status: 'created' | 'error';
  message?: string;
}
```

**Example:**

```typescript
const confirmation = confirmWallet("wallet_abc123def456");
// {
//   walletId: 'wallet_abc123def456',
//   status: 'created',
//   message: 'Wallet successfully created'
// }
```

## Usage

### Complete Handshake Flow

```typescript
import { registerWallet, confirmWallet } from "./handshake";

// Step 1: Register
const registration = registerWallet();
console.log(`Wallet ID: ${registration.walletId}`);
console.log(`Challenge: ${registration.challenge}`);

// Step 2: Confirm
const confirmation = confirmWallet(registration.walletId);
console.log(`Status: ${confirmation.status}`);
// Status: created
```

## Data Model

### RegisterResponse

| Field     | Type      | Description                       |
| --------- | --------- | --------------------------------- |
| walletId  | string    | Unique pending wallet identifier  |
| challenge | string    | Challenge string for verification |
| status    | 'pending' | Current status is always pending  |

### ConfirmResult

| Field    | Type                 | Description                   |
| -------- | -------------------- | ----------------------------- |
| walletId | string               | The wallet ID being confirmed |
| status   | 'created' \| 'error' | Result of confirmation        |
| message  | string               | Optional message with details |

## Handshake Flow

```
1. Client calls registerWallet()
   ↓
   ✓ Returns: walletId (pending), challenge string

2. Client calls confirmWallet(walletId)
   ↓
   ✓ Returns: status = 'created'

3. Wallet is ready to use
```

## Running Tests

```bash
npm test
# or
pnpm test
```

Tests cover:

- Register endpoint returns required fields
- Challenge string is generated
- Confirm endpoint accepts valid wallet ID
- Full handshake sequence (register → confirm)
- Multiple concurrent registrations
