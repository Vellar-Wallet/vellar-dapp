# Trustline Manage Mock Route Module

This module provides a mock API for adding and removing trustlines. It tracks state in-memory for testing purposes.

## Requirements Covered
- Add endpoint validates that an `assetCode` and `issuer` are present.
- Remove endpoint returns a 404 style payload if the trustline does not exist.

## Usage
Since this is a simple mock, you can test its behavior by executing the included test script.

```bash
node test.js
```
