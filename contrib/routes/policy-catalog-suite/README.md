# Issue 101 — Policy Catalog with Validation Rules

Self-contained policy catalog system with validation rules for different policy types.

## Requirements Covered
- Policy catalog with multiple policy types (spending_limit, transfer_whitelist, time_lock, multi_sig)
- Each policy type has at least two validation rules
- Three endpoints: list-types, get-rules, and validate
- Validate endpoint returns detailed pass/fail results for each rule
- Fully deterministic and self-contained (no external dependencies)
- Comprehensive test coverage for passing and failing configurations

## Endpoints

### 1. list-types
Returns all available policy types with descriptions.

**Response:**
```json
{
  "types": [
    {
      "id": "spending_limit",
      "name": "Spending Limit",
      "description": "Controls maximum transaction amounts within time windows"
    },
    ...
  ]
}
```

### 2. get-rules
Returns validation rules for a specific policy type.

**Request:**
```json
{
  "policyType": "spending_limit"
}
```

**Response:**
```json
{
  "policyType": "spending_limit",
  "rules": [
    {
      "id": "minimum_amount",
      "description": "Daily limit must be at least 1 XLM",
      "severity": "error"
    },
    ...
  ]
}
```

### 3. validate
Validates a policy configuration against all rules for its type.

**Request:**
```json
{
  "policyType": "spending_limit",
  "config": {
    "dailyLimit": 100,
    "txLimit": 50
  }
}
```

**Response:**
```json
{
  "valid": true,
  "results": [
    {
      "ruleId": "minimum_amount",
      "passed": true,
      "message": "Daily limit meets minimum requirement"
    },
    ...
  ]
}
```

## Policy Types

### spending_limit
Controls transaction amounts within time windows.
- **Rules:** minimum_amount, maximum_amount, tx_vs_daily_limit

### transfer_whitelist
Restricts transfers to approved recipients.
- **Rules:** minimum_recipients, maximum_recipients

### time_lock
Enforces time-based transaction restrictions.
- **Rules:** minimum_delay, maximum_delay

### multi_sig
Requires multiple signatures for transactions.
- **Rules:** minimum_signatures, maximum_signatures

## Running Tests

```bash
node contrib/routes/policy-catalog-suite/route.test.mjs
```

## Running as HTTP Server

```bash
node contrib/routes/policy-catalog-suite/route.mjs
```

Server listens on port 4101 (or PORT environment variable).
