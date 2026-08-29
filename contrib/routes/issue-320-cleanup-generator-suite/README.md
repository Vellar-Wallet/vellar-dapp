# Issue 320 — Lifecycle Cleanup Plan Generator Unit Tests

Unit test suite covering account state variations for the lifecycle cleanup plan generator.

## Test Scenarios Covered
- Account with 0 linked assets (clean account).
- Account with 1 linked asset (single trustline blocker).
- Account with multiple linked assets (many trustlines + balance transfer blocker).
- Account with pending transactions.
- Structural plan schema validation (`accountId`, `destination`, `blockers`, `estimatedTransactions`, `mergeReady`).
