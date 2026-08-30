# Policy-Service Controller Refactor Design (Issue #350)

## Executive Summary

The `server.ts` controller currently handles both policy validation (input correctness, schema enforcement) and deployment orchestration (instance provisioning, attach verification) in one 300+ line module. This refactor splits these concerns into dedicated modules while preserving the exact current behavior and all existing tests.

---

## 1. Function-Level Classification

All functions/blocks in `buildServer()` classified as follows:

### VALIDATION LOGIC (belongs in `validation.ts`)
These functions validate policy definitions, check request inputs, and verify state consistency. They contain no deployment orchestration, RPC calls, or instance provisioning.

1. **`validateDefinition(definition: unknown): ValidationResult`**
   - Source: `templates.ts` (imported, not in server.ts, but used for validation)
   - Already isolated; re-exported by validation module
   - Validates policy shape against template requirements

2. **`POST /policies/validate` endpoint**
   - Passes request body to `validateDefinition()`
   - Returns validation result
   - **Classification**: Pure validation

3. **`POST /policies/generate` endpoint**
   - Parses input with `generateBodySchema` (input validation)
   - Calls `validateDefinition()` (policy validation)
   - Generates policy record if valid
   - Inserts into repo
   - **Classification**: Mostly validation with repo write; repo interaction is shared coordination (record storage is deployment-agnostic)

4. **Inline: Policy fetch + instance/deployment existence checks**
   - In `/deploy-instance`, `/simulate`, `/policies/deploy`: `await policies.find(id)` + `if (!record)` 404 check
   - In `/deploy-instance`: check `if (record.instance)` for idempotency
   - In `/policies/deploy`: check `if (!record.instance)` before verification
   - In `/simulate` and `/deploy-instance`: check `if (enforcement.kind !== "policy-contract" || !enforcement.constructorArgs)`
   - **Classification**: Validation (state correctness checks, not orchestration)

5. **Wallet address validation**
   - `deployInstanceBodySchema` includes `walletAddress` regex
   - Zod parse failures → 400
   - **Classification**: Input validation

---

### DEPLOYMENT ORCHESTRATION (belongs in `deployment.ts`)
These functions drive the actual deployment process: instance provisioning, budget consumption, attach verification, and state transitions.

1. **`POST /policies/:id/deploy-instance` core logic**
   - Consume sponsor budget (`budget.tryConsume()`)
   - Call `deployer.deployInstance()` to provision instance on-chain
   - Update record with new `instance` field (wallet, contractId, txHash, deployedAt)
   - Set status → "instance_deployed"
   - **Classification**: Pure deployment orchestration

2. **`POST /policies/deploy` core logic**
   - Call `verifyAttachTx()` to confirm attach on-chain (L1 verification)
   - Update record with new `deployment` field (contractId, txHash, deployedAt)
   - Set status → "deployed"
   - **Classification**: Pure deployment orchestration (even though verifyAttachTx is imported; it's orchestration-level verification before state transition)

3. **`POST /policies/:id/simulate` core logic**
   - Call `deployer.simulateInstance()` for dry-run
   - Return result (no state change)
   - **Classification**: Deployment-level operation (it's the deploy contract, not real deployment, but is tied to deployer)

4. **Error handling specific to deployment**
   - `PolicyDeployError` catch → 502 with deploy error code
   - `AttachUnconfirmedError` → 503 (retryable)
   - `AttachMismatchError` → 422 (definite mismatch)
   - Budget accounting errors → 503
   - **Classification**: Deployment-specific error handling

---

### SHARED/COORDINATION LOGIC (belongs in controller or shared utilities)
These functions coordinate between validation and deployment or handle concerns that don't cleanly belong to either.

1. **`POST /policies/templates` endpoint**
   - Lists available templates (metadata, not validation or deployment)
   - **Classification**: Metadata/coordination (shared, belongs in controller)

2. **Policy repository abstraction**
   - `PolicyRepository` interface (insert, find, update)
   - Persistence is independent of validation or deployment
   - Both validation (generate) and deployment (deploy-instance, deploy) depend on it
   - **Classification**: Shared infrastructure

3. **`GET /policies/:id` endpoint**
   - Simple fetch and return
   - **Classification**: Shared query (coordination)

4. **`PolicyRecord` and `PolicyServiceDeps` interfaces**
   - Data structures used by all three concerns
   - **Classification**: Shared types

5. **Metrics recording**
   - `recordOutcome(domainMetrics.policyDeployed, ...)` calls in deploy-instance
   - Tied to the actual deployment outcome
   - **Classification**: Deployment-level metrics (belongs in deployment or orchestration)

6. **`POST /policies/:id/deploy-instance` idempotency check**
   - `if (record.instance) return existing` — prevents redundant deploys
   - This is a deployment-level concern (don't re-provision) but also a validation concern (reject if already deployed)
   - **Classification**: Shared — idempotency guard (belongs in deployment orchestration, but involves validation check)

---

## 2. Shared State Analysis

### Current State Flow

1. **Policy Repository** (`PolicyRecord`)
   - Single source of truth for all policy state
   - Shared by validation (`generate` inserts), deployment (`deploy-instance` and `deploy` update), and queries (GET)
   - **Passing mechanism**: Dependency-injected `policies` parameter; modules receive it as a parameter, not via closure

2. **PolicyServiceDeps**
   - Injected dependencies (deployer, budget, verifyAttach, network config, etc.)
   - Used by deployment logic only (deployment module will receive as parameter)
   - Used by controller for wiring

3. **Data flow through /deploy-instance**:
   - Request: `{ wallet: string }`
   - Load record: `await policies.find(id)`
   - Validation check: `if (!record) 404`; `if (record.instance) return existing`; check enforcement kind
   - Deployment: Call `deployer.deployInstance()`
   - State update: `record.instance = {...}`, `record.status = "instance_deployed"`, `await policies.update(record)`
   - Response: Return updated record + contractId

4. **Data flow through /deploy**:
   - Request: `{ policyId, txHash, contractId? }`
   - Load record: `await policies.find(id)`
   - Validation check: `if (!record) 404`; `if (!record.instance) 422` (if verifyAttach enabled)
   - Deployment: Call `verifyAttachTx()` (verification, not provisioning, but deployment-level)
   - State update: `record.status = "deployed"`, `record.deployment = {...}`, `await policies.update(record)`
   - Response: Return updated record

### Decision: Explicit Parameter Passing

- **Validation module** receives `policies` parameter + request data
- **Deployment module** receives `policies` parameter + deployer/budget/verifyAttach deps + request data
- **Controller** receives all deps, passes to modules
- **No shared mutable state** — modules return results (success/error/validated data), controller or caller decides next step
- **Repo updates**: Done by deployment module (state transitions are deployment-level concerns), not validation

---

## 3. Module Boundaries & Interface Preservation

### New Modules

#### **`validation.ts`**
Exports:
- `validatePolicyDefinition(definition: unknown): ValidationResult` — re-export of templates.validateDefinition
- `validatePolicyForDeployment(record: PolicyRecord): { valid: boolean; error?: string }` — new function to check if policy can be deployed (has enforcement.kind === "policy-contract" && constructorArgs)
- `validatePolicyInstance(record: PolicyRecord): { valid: boolean; error?: string }` — new function to check if instance exists and is valid

Handles:
- Input schema validation (Zod schemas)
- Policy definition validation
- Record state validation (idempotency checks, enforcement availability)

**Does NOT handle**:
- Deployment orchestration
- Repository updates
- RPC calls

#### **`deployment.ts`**
Exports:
- `deployPolicyInstance(deps: DeploymentDeps, record: PolicyRecord, wallet: string): Promise<{ record: PolicyRecord; contractId: string }>`
  - Consumes budget, calls deployer.deployInstance, updates record, returns updated record
  
- `verifyAndRecordAttach(deps: DeploymentDeps, record: PolicyRecord, txHash: string, contractId?: string): Promise<PolicyRecord>`
  - Verifies attach tx, updates record with deployment state, returns updated record
  
- `simulatePolicyDeploy(deps: DeploymentDeps, record: PolicyRecord, wallet: string): Promise<SimulateResult>`
  - Dry-run simulation, no state change, returns result

Handles:
- Sponsor budget consumption
- Instance provisioning
- L1 attach verification
- State transitions and record updates
- Deployment-specific error handling
- Metrics recording

**Does NOT handle**:
- Input validation (that's validation module's job)
- Policy definition validation

#### **`server.ts` (refactored)**
Remains the thin coordinator/HTTP handler:
- Registers routes
- Parses Zod schemas
- Calls validation and deployment modules
- Maps responses to HTTP status codes
- No business logic beyond orchestration

---

### Module Dependencies

```
server.ts
├── imports: fastify, zod, validation.ts, deployment.ts
├── depends on: PolicyRepository, PolicyServiceDeps, templates (for re-exports)
└── routes call: validation.* and deployment.*

validation.ts
├── imports: templates.ts, zod
├── exports: validation functions
└── does NOT import: deployment.ts, deploy.ts, verify-attach.ts

deployment.ts
├── imports: deploy.ts, verify-attach.ts, @service-kit (metrics)
├── exports: deployment orchestration functions
└── does NOT import: validation.ts

templates.ts, deploy.ts, verify-attach.ts
├── unchanged
└── existing imports/exports unchanged
```

---

### Controller Interface Preservation

**HTTP API: unchanged**
- All endpoints return same status codes, response shapes, and error messages
- All request body schemas remain the same
- All side effects (repository updates, budget consumption, metrics) happen in the same order

**Test Harness: unchanged**
- `buildServer()` signature and behavior: identical
- `createMemoryPolicyRepository()`: unchanged
- `PolicyRepository` interface: unchanged
- Tests import and call endpoints via Fastify `inject()`, not internal modules
- No test modifications to assertion logic or expected values

**Dependencies injection: unchanged**
- `PolicyServiceDeps` interface: unchanged
- All deps flow the same way (injected at buildServer, used internally)
- Backward compatibility: yes, modules are internal; only buildServer is public

---

## 4. Error Propagation & Control Flow

### Current behavior (must be preserved)

1. **`/policies/generate`**:
   - Zod parse fail → 400
   - Policy validation fail → 422 with errors
   - Success → 201 with record

2. **`/policies/:id/deploy-instance`**:
   - No deployer → 503
   - Zod parse fail → 400
   - Record not found → 404
   - Instance already exists → 200 (idempotent return, no re-deploy)
   - Budget check fail → 503 (fail closed)
   - Budget consume fail → 503
   - Enforced by non-contract policy → 422
   - Deployer throws PolicyDeployError → 502 with error.code
   - Success → 200 with updated record

3. **`/policies/deploy`**:
   - Zod parse fail → 400
   - Record not found → 404
   - No instance (if verify enabled) → 422
   - Verify throws AttachUnconfirmedError → 503 (retryable)
   - Verify throws AttachMismatchError → 422 (definite lie)
   - Success → 200 with updated record

### Implementation: No changes to control flow

- Validation module returns validation results; deployment module checks and returns HTTP response codes
- Deployment module throws errors; controller catches and maps to HTTP responses
- All status transitions and idempotency checks preserved

---

## 5. No Behavior Changes

This is a pure refactor. No bugs will be fixed, no features added.

### Intentional behaviors preserved (including quirks)

1. **Idempotent instance deploy**: `if (record.instance) return existing` — does NOT re-deploy but DOES return the record. Deployed.
2. **Instance must exist for attach verification**: `/deploy` checks `!record.instance` only if `verifyAttach` is set. If not set, verification is skipped entirely.
3. **Budget is "fail closed"**: Any budget accounting error (consume throws) → 503, even if it's an internal DB error. This is intentional (FIX 3 comment).
4. **Deployment error codes bubble up**: PolicyDeployError codes (deploy_simulation_failed, deploy_submit_failed, etc.) are returned to the client as-is.

---

## 6. Testing Strategy

### Existing tests: run unchanged
- All tests in `server.test.ts` call through the public Fastify API (`app.inject()`)
- No tests call internal functions that will move
- No modifications to test assertions or expected values

### New module tests

#### **`validation.test.ts`** (isolated validation tests)
- Test `validatePolicyForDeployment()` directly: true for contract-enforced policies, false for others
- Test `validatePolicyInstance()` directly: true if instance exists, false otherwise
- Test Zod schema validation (wallet address format, policyId required, etc.)
- No deployment setup needed

#### **`deployment.test.ts`** (isolated deployment tests, mocked external calls)
- Test `deployPolicyInstance()` with mocked deployer: verify budget consume is called, instance record is updated, status → "instance_deployed"
- Test budget failure path: budget.tryConsume returns ok:false → 503 returned by coordinator
- Test deployer error path: throws PolicyDeployError → caught and 502 returned
- Test `verifyAndRecordAttach()` with mocked TxLookup: verify SUCCESS + correct policy → record.deployment set; NOT_FOUND → AttachUnconfirmedError; FAILED → AttachMismatchError
- Test `simulatePolicyDeploy()` with mocked deployer: returns simulation result, no state change

#### **`server.test.ts` (existing tests, should pass unchanged)**
- All 30+ existing tests run as-is
- Verify they still call the same endpoints with same payloads and get same responses
- No test modifications

#### **Coordinator integration test** (verify wiring is correct)
- One new test in server.test.ts (or separate integration.test.ts)
- Call `/deploy-instance`, verify deployment module state transition happened + record persisted
- Call `/deploy`, verify attach verification and deployment record state transition happened
- Verify control flow (if validate fails, deploy is skipped)

---

## 7. Summary Table

| Concern | Current | New Home | Reason |
|---------|---------|----------|--------|
| validateDefinition | templates.ts (imported) | validation.ts (re-export) | Validation module centralizes all validation logic |
| POST /validate | server.ts | controller in server.ts | Thin coordinator remains |
| POST /generate | server.ts | coordinator (validation module does work) | Coordination of validation + repo insert |
| POST /templates | server.ts | controller in server.ts | Metadata query, belongs in coordinator |
| GET /id | server.ts | controller in server.ts | Query, belongs in coordinator |
| POST /deploy-instance | server.ts | coordinator (deployment module does work) | Coordination of deploy + state update |
| POST /deploy | server.ts | coordinator (deployment module does work) | Coordination of verify + state update |
| POST /simulate | server.ts | coordinator (deployment module does work) | Coordination of simulate request |
| Budget check | server.ts | deployment.ts | Deployment orchestration |
| Deployer call | server.ts | deployment.ts | Deployment orchestration |
| Verification call | server.ts | deployment.ts | Deployment orchestration |
| Record updates | server.ts | deployment.ts | State transition is orchestration concern |
| Error handling | server.ts | controller + modules | Some errors caught by modules, 503/502/422 mapping in controller |

---

## Rationale

1. **Validation is pure**: Input checking, schema validation, record state validation — all pure functions returning validity info. They must not know about deployment.
2. **Deployment is orchestration**: Budget, deployer, verification, state transitions — these ARE deployment concerns. Validation doesn't care if a policy is deployable; deployment does.
3. **Controller is thin**: Routes → parse → call validation or deployment → map result to HTTP response. No business logic.
4. **No shared mutable state**: Modules return results; results are passed to other modules or mapped to HTTP responses. Reduces coupling and makes testing easier.
5. **Backward compatible**: buildServer() signature unchanged, HTTP API unchanged, all existing tests pass, no breaking changes.

