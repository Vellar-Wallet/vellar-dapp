# @vellar/wallet-service

Wallet metadata, account preferences, session/device records, audit logs.

## RPC Retry & Circuit Breaker Policy

During Stellar RPC endpoint degradation or transient outages, `wallet-service` applies exponential backoff with randomized jitter and an automated circuit breaker to prevent retry storms:

- **Exponential Backoff**: Retries failed submission attempts up to `maxRetries` (default: 3) using base delay `initialDelayMs` (default: 100ms), multiplier factor 2, capped at `maxDelayMs` (default: 3000ms), combined with 0-50% random jitter to avoid thundering herd problems.
- **Circuit Breaker**: Tracks consecutive submission/transport failures. When failures reach `failureThreshold` (default: 5), the circuit state transitions to `OPEN` for `resetTimeoutMs` (default: 30000ms). Submissions attempted while the breaker is OPEN immediately reject with `CircuitBreakerOpenError` without placing further load on the upstream RPC network.

