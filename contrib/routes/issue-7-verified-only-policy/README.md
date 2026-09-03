# Issue 7 — Verified-Only Policy Template (B7)

Mock route module and template definitions for selecting, validating, and generating the verified-only policy through the policy service API.

## Requirements
- Defines the `verified_only` template, title, and description.
- Validates parameter schemas including registry address and enforcement mode (`strict` / `trusted_publishers`).
- Declares the honest on-chain enforcement descriptor stating enforcement is a policy contract checking a verified registry.
- Includes constructor arguments in generated policy manifest.
