# Issue 24 — Safety Policy E2E Lifecycle & Positioning Review (A12)

Mocked end-to-end test suite and wording review for the safety policy lifecycle.

## Requirements Covered
- End to end test covering: configure safety policy -> review -> deploy -> attempt violating transaction -> receive rejection explanation.
- Fully mocked gateway/chain reads (runs in CI without funded account or relayer key).
- Wording review: describes on-chain spending controls for known transfer patterns without claiming universal protection or intent firewalls.
- Confirms no amount is presented in fiat anywhere in the feature.
- Deterministic execution without timing races between UI states.
