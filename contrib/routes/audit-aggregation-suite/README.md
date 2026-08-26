# Issue 109 — Audit Log Aggregation with Filters

Route suite for querying and aggregating audit log entries with support for filtering by actor, action, and pagination.

## Endpoints

### GET /entries
Returns audit log entries with optional filtering and pagination support.

**Query Parameters:**
- `actor` (optional): Filter by actor ID or system component
- `action` (optional): Filter by action type (create, update, delete, approve, reject, transfer, etc.)
- `limit` (optional): Number of entries per page (default: 10, max: 100)
- `offset` (optional): Offset for pagination (default: 0)

**Response:**
```json
{
  "entries": [...],
  "pagination": {
    "limit": 10,
    "offset": 0,
    "total": 30,
    "hasMore": true
  }
}
```

### GET /summary
Returns aggregated counts of audit log entries grouped by action type across the full dataset.

**Response:**
```json
{
  "summary": {
    "create": 8,
    "update": 7,
    "delete": 5,
    "approve": 4,
    "reject": 3,
    "transfer": 3
  },
  "totalEntries": 30
}
```

## Features
- Self-contained with deterministic sample dataset
- Supports combined filtering (actor + action)
- Pagination with limit and offset
- Action-based aggregation for summary statistics
- Full test coverage including combined filters

## Sample Audit Log Entry
```json
{
  "id": "audit-001",
  "timestamp": "2024-01-15T10:30:00Z",
  "actor": "user-alice",
  "action": "create",
  "resource": "wallet-001",
  "result": "success"
}
```

## Running the Route
```bash
node route.mjs
# Server listens on port 4109 by default
```

## Running Tests
```bash
node route.test.mjs
```
