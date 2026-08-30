# Secrets Audit Findings - Issue #307 - Worker Service

**Date**: 2026-08-28
**Service**: worker-service
**Scope**: All config loading, environment variable handling, logging, and secret management

---

## STEP 1: Full Audit Results

### 1.1 Environment Variables Identified

| Variable | Classification | Where Loaded | Usage | Risk |
|----------|----------------|--------------|-------|------|
| `DATABASE_URL` | SECRET | config.ts L28 | Connection string to Postgres | High - contains credentials |
| `STELLAR_RPC_URL` | Non-secret | config.ts L30 | RPC endpoint URL | Low - public URL |
| `STELLAR_NETWORK_PASSPHRASE` | Non-secret | config.ts L31 | Network passphrase | Low - network identifier |
| `STELLAR_NETWORK` | Non-secret | config.ts L42 | Network name | Low - public identifier |
| `ATTESTOR_SECRET_KEY` | SECRET | config.ts L51 | Ed25519 private key for attestor | Critical - private key |
| `ATTESTATION_REGISTRY_ID` | Non-secret | config.ts L52 | Registry contract ID | Low - public ID |
| `VERIFY_BUILD_IMAGE` | Non-secret | config.ts L34 | Docker image name | Low - image reference |
| `VERIFY_POLL_IDLE_MS` | Non-secret | config.ts L35 | Poll interval | Low - numeric |
| `VERIFY_BUILD_TIMEOUT_S` | Non-secret | config.ts L36 | Build timeout | Low - numeric |
| `VERIFY_BUILD_MEMORY` | Non-secret | config.ts L37 | Container memory | Low - numeric |
| `VERIFY_BUILD_CPUS` | Non-secret | config.ts L38 | Container CPUs | Low - numeric |
| `VERIFY_BUILD_PIDS_LIMIT` | Non-secret | config.ts L39 | Process limit | Low - numeric |
| `ATTESTATION_TTL_LEDGERS` | Non-secret | config.ts L54 | TTL value | Low - numeric |
| `ATTESTATION_SWEEP_MS` | Non-secret | config.ts L55 | Sweep interval | Low - numeric |
| `VERIFY_REAP_TIMEOUT_MS` | Non-secret | config.ts L56 | Reap timeout | Low - numeric |
| `VERIFY_REAP_INTERVAL_MS` | Non-secret | config.ts L57 | Reap interval | Low - numeric |
| `VERIFY_MAX_ATTEMPTS` | Non-secret | config.ts L58 | Max retry count | Low - numeric |
| `ALLOW_SINGLE_KEY_ATTESTOR` | Non-secret | index.ts L112 | Feature flag | Low - boolean |
| `AWS_REGION` | Non-secret | Not directly used | AWS configuration (if using AWS secrets manager) | Low - regional identifier |
| `WORKER_METRICS_PORT` | Non-secret | index.ts L79 | Metrics server port | Low - numeric |

### 1.2 Secret Loading Paths

**Primary secrets:**
1. `DATABASE_URL` - Postgres connection string (contains password)
   - Location: config.ts, line 28
   - Status: Loaded from env, passed to pg.Pool constructor (index.ts L35)
   - Risk: Could be logged if full connection string is exposed

2. `ATTESTOR_SECRET_KEY` - Ed25519 private key
   - Location: config.ts, line 51
   - Usage: Passed to `Keypair.fromSecret()` in registry-submitter.ts (L31)
   - Risk: Keypair operations could expose key in error messages

### 1.3 Logging Calls Found

**NO direct logging of secrets found**, but CRITICAL RISKS identified:

1. **index.ts L38-39**: Error logging
   ```typescript
   console.error(
     "[worker-service] DATABASE_URL is not set — the build worker needs the shared verification store. Exiting.",
   );
   ```
   **Risk**: If DATABASE_URL is present but invalid, error details might be logged. Currently safe.

2. **index.ts L96-97**: Error logging in attestor-guard
   ```typescript
   console.error(`[worker-service] ${err instanceof Error ? err.message : String(err)}`);
   ```
   **Risk**: If attestorSecretKey is invalid, error message might contain key details. **POTENTIAL ISSUE**

3. **index.ts L141-142**: Reaper error logging
   ```typescript
   log.error("reaper sweep failed", err);
   ```
   **Risk**: Error object might contain connection details from DATABASE_URL if DB connection fails. **POTENTIAL ISSUE**

4. **registry-submitter.ts L65-67**: Transaction error logging
   ```typescript
   throw new Error(
     `registry ${method} submission rejected: ${JSON.stringify(sent.errorResult)}`,
   );
   ```
   **Risk**: Error result might contain contract details but not secrets. Appears safe.

5. **attestor.ts L97**: Attestor error logging
   ```typescript
   log.error(
     `attestor: mirroring outcome for ${contractId} failed (pipeline unaffected)`,
     err,
   );
   ```
   **Risk**: Error object `err` might contain internal registry-submitter error with secrets. **POTENTIAL ISSUE**

6. **attestor.ts L124**: Sweep error logging
   ```typescript
   log.error(`attestor: sweep failed for ${contractId} (continuing)`, err);
   ```
   **Risk**: Error object propagation might expose secrets. **POTENTIAL ISSUE**

7. **executor.ts**: Spawned process logging
   - Docker child process errors (lines ~300+) might log environment variables
   - **Risk**: If process env is inherited by child, build errors could expose secrets. **POTENTIAL ISSUE**

### 1.4 Inline/Hardcoded Secrets Check

✅ **No inline hardcoded secrets found** - all secrets are loaded from environment variables

### 1.5 Error Handling Risk Analysis

**CRITICAL FINDINGS:**

1. **Error objects passed to logging without redaction**
   - Errors from attestor-guard, reaper, attestor, executor may contain sensitive details
   - Example: Database connection errors expose credentials in error messages

2. **No secrets redactor in place**
   - All error logging uses native Error objects without filtering

3. **Child process environment contamination**
   - Docker executor spawns child processes that could inherit secrets from process.env

---

## STEP 2: Risk Classification

| Risk Level | Count | Items |
|-----------|-------|-------|
| **Critical** | 2 | `ATTESTOR_SECRET_KEY` (Ed25519 key), `DATABASE_URL` (Postgres credentials) |
| **High** | 5 | Error logging in: attestor-guard, reaper, attestor (3 places), executor |
| **Medium** | 0 | |
| **Low** | 18 | Non-sensitive config variables, numeric parameters |

---

## STEP 3: Remediation Plan

### Fix 1: Create secrets redactor utility
- File: `src/config/secretsRedactor.ts`
- Redacts DATABASE_URL and ATTESTOR_SECRET_KEY from logs
- Implements redact(obj), redactString(str), safeLog()
- Called before all error logging

### Fix 2: Update error logging paths
- Replace all `log.error()` calls with `safeLog('error', ...)`
- Wrap error objects with redact()
- Affected files: index.ts (3 places), attestor.ts (2 places), executor.ts (1 place)

### Fix 3: Validate secrets at startup
- File: `src/config/validateSecrets.ts`
- Ensure DATABASE_URL and ATTESTOR_SECRET_KEY are present if required
- Fail fast with clear error messages (no secret values logged)

### Fix 4: Documentation
- Update `docs/decisions.md` with findings
- Add secrets classification table
- Document redaction strategy
- Add recommendations for AWS Secrets Manager

### Fix 5: Tests
- Create `tests/unit/secrets-audit.test.ts`
- Test: secrets never appear in log output
- Test: redactor removes secret values
- Test: startup validation
- Test: no inline secrets in source

---

## STEP 4: Security Recommendations

### Immediate (Must Do)
1. ✅ Implement secrets redactor
2. ✅ Update all logging calls to use redactor
3. ✅ Add startup validation
4. ✅ Add comprehensive tests

### Short-term (Recommended)
1. Adopt AWS Secrets Manager for production deployments
2. Add secret rotation policies
3. Implement audit logging for secret access

### Long-term (Best Practice)
1. Use HashiCorp Vault for multi-region deployments
2. Implement PKI for certificate management
3. Use workload identity (IRSA for Kubernetes) to avoid secret storage

---

## Files to Modify

| File | Changes | Lines | Priority |
|------|---------|-------|----------|
| NEW: `src/config/secretsRedactor.ts` | Create | ~100 | Critical |
| `src/index.ts` | Update error logging | 3-5 | Critical |
| `src/attestor.ts` | Update error logging | 2-3 | Critical |
| `src/config/validateSecrets.ts` | Create | ~50 | Critical |
| NEW: `tests/unit/secrets-audit.test.ts` | Create | ~200 | High |
| `docs/decisions.md` | Add findings section | ~100 | High |

---

## Acceptance Criteria

- [ ] Secrets redactor created and applied to all logging
- [ ] All error logging uses redact() wrapper
- [ ] Startup validation fails fast when secrets missing
- [ ] No existing tests broken
- [ ] New tests pass (secrets audit)
- [ ] docs/decisions.md updated with findings
- [ ] No changes to worker business logic
- [ ] Branch created: `fix/worker-service-secrets-audit`
