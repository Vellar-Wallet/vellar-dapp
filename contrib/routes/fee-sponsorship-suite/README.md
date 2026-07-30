# Fee Sponsorship Suite

A self-contained route handler simulating fee sponsorship across multiple mock submissions.

## Endpoints

### POST /submit

Submits a transaction with fee sponsorship. Each submission deducts a fee amount from the in-memory sponsor balance. Rejects with a clear error once the sponsor balance would go negative.

**Request Body:**
```json
{
  "transactionId": "tx1",
  "fee": 100
}
```

**Response (success):**
```json
{
  "transactionId": "tx1",
  "feeDeducted": 100,
  "remainingBalance": 900,
  "status": "accepted"
}
```

**Response (insufficient balance):**
```json
{
  "error": "Insufficient sponsor balance",
  "transactionId": "tx1",
  "requiredFee": 100,
  "currentBalance": 50
}
```

### GET /sponsor-balance

Returns the current sponsor account balance.

**Response:**
```json
{
  "balance": 900,
  "initialBalance": 1000,
  "totalFeesDeducted": 100
}
```

## Running the Test

```bash
node test.ts
```

This test demonstrates several successful submissions and one rejected once the budget runs out.
