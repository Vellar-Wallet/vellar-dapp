# Client-Side Analytics Events

Client-side analytics track user interactions with the wallet, enabling measurement of conversion funnels, error rates, and user behavior patterns.

## Overview

Analytics events are emitted from the web app (`apps/web`) and follow the same **dot-notation naming convention** as backend events (e.g., `wallet.created`, `wallet.signin.failed`). Events are buffered in memory and persisted to localStorage for later transmission to an analytics backend (not yet implemented; currently logged to console in development).

**Privacy by design**: Sensitive data (seed phrases, private keys, passwords, raw session IDs) are never included in events. Session IDs are hashed (SHA-256, truncated to 12 hex characters) before correlation.

## Architecture

### Client Analytics Tracker (`apps/web/lib/analytics.ts`)

The `createAnalyticsTracker()` function provides:

- **Event emission** (`emit(name, properties, context)`): queues an event with auto-generated timestamp and page session ID
- **Flushing** (`flush()`): persists queued events to localStorage (production use would send to backend)
- **Hashing** (`hashValue(value)`): safely hashes sensitive values (e.g., session IDs) for correlation
- **Global singleton** (`getAnalyticsTracker()`): provides app-wide access to the tracker

### EventContext

Every event includes this auto-attached context:

```typescript
interface EventContext {
  sessionId?: string;        // Hashed wallet session ID (for correlation)
  contractId?: string;       // Smart account contract address (public)
  network?: Network;         // Network identifier (testnet/mainnet/etc)
  timestamp: string;         // ISO 8601 timestamp
  pageSessionId: string;     // Unique browser session token (persists across reloads)
}
```

**Note**: `sessionId` is the **caller's responsibility** to hash before passing to event helpers. Helpers accept it as-is and do not perform additional hashing.

## Event Definitions

### Wallet Creation Funnel

The wallet creation flow includes these events:

#### `wallet.funnel.start`

Fired when user arrives at the onboarding entry point (`/app`).

**When**: Page load / component mount
**Properties**: None
**Context**: `network`

**Example**:
```json
{
  "name": "wallet.funnel.start",
  "properties": {},
  "context": {
    "network": "testnet",
    "pageSessionId": "1234567890-abc123",
    "timestamp": "2026-08-28T14:30:00.000Z"
  }
}
```

#### `wallet.creation.initiated`

Fired when user clicks "Create wallet" button and passkey prompt is about to open.

**When**: User clicks "Create wallet" button
**Properties**:
- `hasUsername` (boolean): whether user provided an optional wallet name

**Context**: `network`

**Example**:
```json
{
  "name": "wallet.creation.initiated",
  "properties": { "hasUsername": true },
  "context": { "network": "testnet", "timestamp": "2026-08-28T14:30:05.000Z" }
}
```

#### `wallet.creation.cancelled`

Fired when user dismisses the passkey prompt before confirming (not an error).

**When**: User cancels the OS/authenticator passkey dialog
**Properties**: None
**Context**: `network`

**Example**:
```json
{
  "name": "wallet.creation.cancelled",
  "properties": {},
  "context": { "network": "testnet" }
}
```

#### `wallet.creation.passkey_confirmed`

Fired when passkey prompt completes successfully (user confirmed passkey creation).

**When**: Passkey prompt closed with user confirmation
**Properties**: None
**Context**: `network`

**Example**:
```json
{
  "name": "wallet.creation.passkey_confirmed",
  "properties": {},
  "context": { "network": "testnet" }
}
```

#### `wallet.created`

Fired when backend successfully creates the wallet and session is established.

**When**: Backend returns a valid session; wallet is now usable
**Properties**:
- `network` (string): network identifier
- `hasUsername` (boolean): whether wallet was created with a user-provided name

**Context**:
- `network` (should match properties.network for redundancy)
- `contractId` (string): smart account contract address
- `sessionId` (string): **hashed** wallet session ID (for correlation across events)

**Example**:
```json
{
  "name": "wallet.created",
  "properties": { "network": "testnet", "hasUsername": true },
  "context": {
    "network": "testnet",
    "contractId": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "sessionId": "a1b2c3d4e5f6",
    "pageSessionId": "1234567890-abc123",
    "timestamp": "2026-08-28T14:30:10.000Z"
  }
}
```

#### `wallet.creation.failed`

Fired when wallet creation encounters an error.

**When**: Passkey creation fails or backend provisioning fails
**Properties**:
- `failureReason` (string): user-safe error message (must **not** contain seed phrases, keys, or passwords)
- `step` (string): `"passkey"` or `"backend"` — which step failed

**Context**: `network`

**Example**:
```json
{
  "name": "wallet.creation.failed",
  "properties": {
    "failureReason": "A passkey for Vellar already exists on this device. Try signing in instead.",
    "step": "passkey"
  },
  "context": { "network": "testnet" }
}
```

#### `wallet.funnel.completed`

Fired when user successfully reaches the dashboard after wallet creation.

**When**: Dashboard mounts with active wallet session
**Properties**: None
**Context**:
- `network`
- `contractId`
- `sessionId` (hashed)

**Example**:
```json
{
  "name": "wallet.funnel.completed",
  "properties": {},
  "context": {
    "network": "testnet",
    "contractId": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "sessionId": "a1b2c3d4e5f6"
  }
}
```

#### `wallet.funnel.abandoned`

Fired when user leaves the onboarding flow before completion (e.g., navigates away, closes tab).

**When**: Page unload or navigation away before `wallet.funnel.completed`
**Properties**:
- `step` (string): which step the user abandoned at (e.g., `"onboarding"`, `"passkey_prompt"`)

**Context**: `network`

**Note**: Not yet implemented; would require tracking navigation away.

### Sign-In (Connect Wallet) Funnel

Similar structure to creation, for existing wallet sign-in:

#### `wallet.signin.initiated`

Fired when user clicks "Sign in" button.

**When**: User clicks "Sign in"
**Properties**: None
**Context**: `network`

#### `wallet.signin.passkey_confirmed`

Fired when passkey prompt completes successfully during sign-in.

**When**: User confirms passkey in OS/authenticator UI
**Properties**: None
**Context**: `network`

#### `wallet.signin.completed`

Fired when backend successfully authenticates the passkey and session is restored.

**When**: Backend validates passkey and returns session
**Properties**: `{ network: string }`
**Context**:
- `network`
- `contractId` (public account address)
- `sessionId` (hashed)

#### `wallet.signin.failed`

Fired when sign-in encounters an error.

**When**: Passkey fails or backend rejects the passkey
**Properties**:
- `failureReason` (string): user-safe error message

**Context**: `network`

## Data Flow & Funnel Analysis

A complete wallet creation funnel looks like this:

```
1. User loads /app
   ↓ wallet.funnel.start

2. User enters optional name, clicks "Create wallet"
   ↓ wallet.creation.initiated

3. OS/authenticator prompts user to create/confirm passkey
   ↓ (user confirms)
   ↓ wallet.creation.passkey_confirmed

4. Backend creates wallet and session
   ↓ wallet.created

5. App navigates to /dashboard
   ↓ wallet.funnel.completed
```

**Drop-off points**:
- Between start and initiated: user leaves before clicking button
- Between initiated and passkey_confirmed: user cancels passkey dialog
  - Emits `wallet.creation.cancelled` instead
- Between passkey_confirmed and created: backend error
  - Emits `wallet.creation.failed` instead
- Between created and funnel.completed: navigation interruption (unlikely)

## Privacy Constraints

**Never include in events**:
- Raw session IDs or bearer tokens (must be hashed)
- Seed phrases or mnemonic words
- Private keys or key material
- Passwords or PINs
- Personally identifiable information (names, email addresses, IP addresses)

**OK to include**:
- `contractId`: public smart account address (non-sensitive)
- `network`: public identifier (testnet/mainnet)
- `hasUsername`: boolean flag (non-sensitive)
- Error messages: only user-safe versions, sanitized by caller before emission

**Sensitive data handling**:

Session IDs must be hashed by the caller using `tracker.hashValue(sessionId)` before passing to event helpers:

```typescript
// ✗ DO NOT DO THIS
walletCreationEvents.walletCreated(
  { network: "testnet", hasUsername: false },
  { sessionId: rawSessionId } // Raw session ID exposed!
);

// ✓ DO THIS
walletCreationEvents.walletCreated(
  { network: "testnet", hasUsername: false },
  { sessionId: tracker.hashValue(rawSessionId) } // Hashed safely
);
```

## Storage & Transmission

**Current implementation**: Events are buffered in memory and persisted to `localStorage` under the key `vellar.analytics.events`. Up to 1,000 events are stored (older events are dropped).

**Future**: The `flush()` method should be extended to transmit events to a backend analytics service (e.g., via an API endpoint at `/api/analytics`).

**Error handling**: Failed sends do not block wallet operations. Analytics is fire-and-forget to ensure user experience is never degraded by analytics failures.

## Testing

Analytics events are tested in `apps/web/lib/analytics.test.ts`:

- Event emission with correct properties
- Context merging and auto-attached fields
- Privacy constraints (no sensitive data)
- localStorage persistence
- Queue management

Run tests with:
```bash
npm run test
```

## Implementation Reference

### Emitting events in components

```typescript
import { getAnalyticsTracker, walletCreationEvents } from "@/lib/analytics";

// Emit wallet creation initiated
walletCreationEvents.createInitiated(
  { hasUsername: !!username },
  { network: config.network }
);

// Hash sensitive values before passing
const sessionHash = getAnalyticsTracker().hashValue(session.sessionId);
walletCreationEvents.walletCreated(
  { network: config.network, hasUsername: !!username },
  {
    network: config.network,
    contractId: session.contractId,
    sessionId: sessionHash,
  }
);

// Flush before critical operations (navigation, page unload)
await getAnalyticsTracker().flush();
```

### Adding a new event type

1. Define the event in `walletCreationEvents` or `walletSignInEvents` object
2. Call `getAnalyticsTracker().emit(name, properties, context)`
3. Add tests in `analytics.test.ts` verifying event name, properties, and privacy
4. Document in this file

## Conventions

- **Event names**: lowercase, dot-notation, `entity.action` format (e.g., `wallet.created`, `wallet.signin.failed`)
- **Property names**: camelCase, concise
- **Context fields**: camelCase, inherited from `EventContext` interface
- **Timestamps**: ISO 8601 format (auto-attached)
- **Session ID correlation**: hashed SHA-256, truncated to 12 hex characters
- **Error messages**: user-safe, no technical jargon or internal details

## Backend Integration

When a backend analytics service is ready, update the `flush()` method in `apps/web/lib/analytics.ts`:

```typescript
async function flush() {
  if (eventQueue.length === 0) return;
  const events = eventQueue.splice(0);
  
  try {
    // Send to backend
    await fetch("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    });
  } catch (err) {
    // Silently ignore failures
    console.error("[analytics] send failed:", err);
  }
}
```

Ensure the backend:
- Validates event structure
- Handles deduplication (same pageSessionId + timestamp = duplicate)
- Respects privacy constraints (rejects events with suspicious payloads)
- Stores events durably (database, data warehouse, etc.)
