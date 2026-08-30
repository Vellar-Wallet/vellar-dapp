# Wallet Reconnect Mock Route

A self-contained mock route module simulating reconnection to an existing wallet using a stored key identifier.

## Overview

This module provides a mock implementation of wallet reconnection that allows users to reconnect to their existing wallets by providing a stored key identifier. The endpoint matches the provided keyId against a sample dataset and returns the corresponding walletId or a 404-style error.

## API

### Reconnect Endpoint

**Function:** `reconnectWallet(keyId: string): ReconnectResult`

Attempts to reconnect to a wallet using a stored key identifier.

**Parameters:**

- `keyId`: The stored identifier for the wallet key

**Returns:**

```typescript
// Success (200):
{
  success: true;
  walletId: string;
  keyId: string;
}

// Not Found (404):
{
  success: false;
  error: "NOT_FOUND";
  message: string;
}
```

**Example - Known Key:**

```typescript
const result = reconnectWallet("key_user_001");
// {
//   success: true,
//   walletId: 'wallet_abc123def456',
//   keyId: 'key_user_001'
// }
```

**Example - Unknown Key:**

```typescript
const result = reconnectWallet("key_unknown");
// {
//   success: false,
//   error: 'NOT_FOUND',
//   message: 'Key not found in wallet registry'
// }
```

## Sample Dataset

The module includes a predefined set of key-to-wallet mappings:

| keyId          | walletId               |
| -------------- | ---------------------- |
| `key_user_001` | `wallet_alice_primary` |
| `key_user_002` | `wallet_bob_primary`   |
| `key_user_003` | `wallet_carol_primary` |

## Usage

```typescript
import { reconnectWallet } from "./reconnector";

// Known key
const knownResult = reconnectWallet("key_user_001");
if (knownResult.success) {
  console.log(`Connected to ${knownResult.walletId}`);
}

// Unknown key
const unknownResult = reconnectWallet("key_invalid");
if (!unknownResult.success) {
  console.log(`Error: ${unknownResult.message}`);
}
```

## Data Model

### ReconnectResult

#### Success Response

| Field    | Type   | Description                           |
| -------- | ------ | ------------------------------------- |
| success  | true   | Indicates successful reconnection     |
| walletId | string | The wallet ID associated with the key |
| keyId    | string | The key ID that was looked up         |

#### Error Response

| Field   | Type        | Description                  |
| ------- | ----------- | ---------------------------- |
| success | false       | Indicates lookup failure     |
| error   | 'NOT_FOUND' | Error code                   |
| message | string      | Human-readable error message |

## Running Tests

```bash
npm test
# or
pnpm test
```

Tests cover:

- Reconnecting with a known keyId
- Retrieving the correct walletId
- Handling unknown keyId (404 style error)
- Consistent results across multiple calls
- All sample keys are accessible
