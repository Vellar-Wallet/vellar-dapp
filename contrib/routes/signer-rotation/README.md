# Signer Rotation Mock Route Module

This module provides a mock API for requesting and polling the status of a signer key rotation. It tracks state in-memory for testing purposes.

## Requirements Covered
- `requestRotationEndpoint`: Returns a `rotationId` and an initial `pending` status.
- `checkStatusEndpoint`: Transitions the status of a request from `pending` to `completed` after it has been polled a fixed number of times.

## Usage
Run the test script to simulate requesting a rotation and polling until completion:

```bash
node test.js
```
