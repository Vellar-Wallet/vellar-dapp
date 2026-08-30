# Safety Policy (Issue #13 / A1)

Implementation of contract-side helper `parse_authorization_context` that parses protocol authorization contexts (`soroban_sdk::auth::Context`) into typed interactions for safety policy evaluation.

## Features
- Parses SEP-41 token transfers (`Interaction::TokenTransfer`).
- Classifies non-transfer contract calls (`Interaction::OtherContractCall`).
- Handles malformed or unrecognized contexts as `Interaction::Unknown`.
- Bounded context evaluation up to 10 entries per authorization call.
