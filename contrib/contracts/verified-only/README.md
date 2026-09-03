# Verified-Only Policy Contract (Issue #4 / B4)

Implementation of policy contract enforcing that target contracts in authorization contexts must be registered and verified in the verification registry.

## Features
- Resolves target contract address from authorization context (`Context::Contract`).
- Enforces registry verification via cross-contract call (`is_verified`).
- Denies by default when target contract is unverified or cannot be determined.
- Covers verified target authorization, unverified rejection, unresolvable target rejection, and revoked target rejection.
