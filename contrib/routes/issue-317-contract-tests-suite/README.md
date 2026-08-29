# Issue 317 — API Gateway & Verification Service Contract Testing

Contract test suite verifying request/response shape compatibility between `api-gateway` (consumer) and `verification-service` (provider).

## Schema Contract Specifications
- **`GET /verification/:contractId`**:
  - Provider response must return `{ contractId: string, status: string, records: Array<VerificationRecord> }`
- **`POST /verification/submit`**:
  - Consumer payload must include `contractId`, `sourceType`, `repoUrl`, `commitHash`, `toolchainVersion`
  - Provider response must return `{ record: VerificationRecord }` with 201 Created status.
