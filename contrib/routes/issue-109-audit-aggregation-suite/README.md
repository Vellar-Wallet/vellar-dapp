# Issue #109 - Audit Aggregation Suite

This suite simulates an audit log API with filtering, pagination, and aggregation.

## Endpoints

### `GET /entries`
Returns a paginated list of audit logs.

**Query Parameters:**
- `actor` (optional): Filter by actor string.
- `action` (optional): Filter by action string.
- `page` (optional): Page number (default: 1).
- `limit` (optional): Items per page (default: 2).

### `GET /summary`
Returns an aggregated summary of logs grouped by action across the entire dataset.

## Running the Test
Execute `node test.js` to fetch the summary and perform filtered, paginated queries on the entries.
