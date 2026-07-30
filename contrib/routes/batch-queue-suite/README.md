# Batch Queue Suite

A self-contained route handler simulating a batched submission queue with retry logic.

## Endpoints

### POST /enqueue-batch

Accepts a batch of mock transactions and processes them in order. A configurable fraction of items fail on the first attempt and succeed on retry.

**Request Body:**
```json
{
  "transactions": [
    { "id": "tx1", "data": "..." },
    { "id": "tx2", "data": "..." }
  ],
  "failureRate": 0.3,
  "maxRetries": 3
}
```

**Response:**
```json
{
  "batchId": "batch-123",
  "totalCount": 2,
  "pending": 2
}
```

### GET /batch-status/:batchId

Returns the status of each item in the batch, including per-item state (pending, retrying, succeeded, or failed after retries exhausted).

**Response:**
```json
{
  "batchId": "batch-123",
  "items": [
    { "id": "tx1", "state": "succeeded", "attempts": 1 },
    { "id": "tx2", "state": "retrying", "attempts": 2 }
  ]
}
```

## Running the Test

```bash
node test.ts
```

This test demonstrates a batch that fully succeeds after retries.
