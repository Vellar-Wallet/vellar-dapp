# Issue #99 - x402 Challenge Suite

This suite simulates an HTTP 402 Payment Required challenge workflow. 

## Endpoints

### `GET /protected`
Returns protected content if a valid payment proof is provided in the headers.

**Headers:**
- `x-payment-proof`: The payment proof string.

**Responses:**
- **200 OK**: If `x-payment-proof` is exactly `valid_mock_proof_123`.
- **402 Payment Required**: If the proof is missing or invalid. Includes a JSON body with the payment challenge details.

## Running the Test
Execute `node test.js` to see the simulated flow of an initial unauthenticated request, an invalid retry, and a successful retry.
