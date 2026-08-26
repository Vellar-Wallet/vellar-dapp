# Issue 100 — Session Budget Enforcement

Mocked session budget tracking and enforcement suite.

## Requirements Covered
- Session budget tracking with spend enforcement
- Rejected requests leave budget unchanged
- Remaining budget reflects only successfully applied spends
- Deterministic execution without external dependencies
- Self-contained test suite

## Endpoints

### POST /spend
Records a spend against the session budget.

**Request body:**
```json
{
  "amount": 100
}
```

**Response (success):**
```json
{
  "success": true,
  "spent": 100,
  "remaining": 900
}
```

**Response (over budget):**
```json
{
  "success": false,
  "error": "insufficient_budget",
  "message": "Requested amount 200 exceeds remaining budget 150",
  "remaining": 150
}
```

### GET /remaining-budget
Returns the current remaining budget.

**Response:**
```json
{
  "remaining": 900,
  "spent": 100,
  "total": 1000
}
```

## Configuration

Default budget: **1000 units**

The budget can be customized by setting the `INITIAL_BUDGET` environment variable when starting the server.
