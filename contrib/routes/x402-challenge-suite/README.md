# Issue 99 — x402 Payment Challenge and Retry Flow

Mock implementation of HTTP 402 Payment Required challenge-response flow.

## Requirements Covered
- Initial request without payment returns 402 with payment challenge details
- Retry with valid payment proof returns protected content (200)
- Invalid or missing proof continues to return 402 with challenge
- Self-contained and deterministic (no external payment processor)
- ES module pattern with testable exports

## Flow

```
Client                          Server
  |                               |
  |  GET /protected               |
  |------------------------------>|
  |                               |
  |  402 Payment Required         |
  |  X-Payment-Challenge: {...}   |
  |<------------------------------|
  |                               |
  |  GET /protected               |
  |  X-Payment-Proof: valid_token |
  |------------------------------>|
  |                               |
  |  200 OK                       |
  |  {protected content}          |
  |<------------------------------|
```

## Endpoints

### GET /protected
Protected resource requiring payment proof.

**Without Payment Proof:**
- Status: 402 Payment Required
- Response includes challenge details with expected payment amount and proof format

**With Invalid Payment Proof:**
- Status: 402 Payment Required
- Response indicates invalid proof and provides fresh challenge

**With Valid Payment Proof:**
- Status: 200 OK
- Returns protected content

## Payment Proof Format

This implementation uses a simple deterministic mock proof system:
- Challenge includes a `challenge_token` and `amount`
- Valid proof is computed as: `sha256(challenge_token + amount + secret_key)`
- For testing purposes, the secret is `"mock_secret_2024"`

## Running the Server

```bash
node route.mjs
# Server listens on port 4099 (configurable via PORT env var)
```

## Running Tests

```bash
node route.test.mjs
```

## Example Usage

```bash
# Initial request - returns 402 with challenge
curl -i http://localhost:4099/protected

# Retry with valid proof
curl -i http://localhost:4099/protected \
  -H "X-Payment-Proof: <computed_proof_from_challenge>"

# Retry with invalid proof - returns 402
curl -i http://localhost:4099/protected \
  -H "X-Payment-Proof: invalid_proof"
```
