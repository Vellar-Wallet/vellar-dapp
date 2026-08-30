# dApp Connect Approve Mock Route Module

This module simulates a dApp connection request and the user approval flow. It tracks connection state in-memory.

## Requirements Covered
- `requestConnectionEndpoint`: Returns a pending `connectionId` tied to the provided `origin`.
- `approveConnectionEndpoint`: Accepts a `connectionId` and a `decision` (`approve` or `deny`), updating the connection's status.

## Usage
Run the test script to see a full approve sequence and a deny sequence:

```bash
node test.js
```
