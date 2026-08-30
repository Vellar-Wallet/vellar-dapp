/**
 * Secrets validation for worker-service startup.
 *
 * Ensures all required secrets are present before the worker starts.
 * Logs names of missing secrets, never their values.
 * Fails fast to prevent half-initialized state.
 */

/**
 * Required secrets that must be present for worker-service to function.
 * DATABASE_URL is always required (shared verification store).
 */
const REQUIRED_SECRETS = ["DATABASE_URL"] as const;

/**
 * Conditional secrets: required when specific features are enabled.
 */
const CONDITIONAL_SECRETS = {
  ATTESTOR_SECRET_KEY: "when attestor feature is enabled",
  ATTESTATION_REGISTRY_ID: "when attestor feature is enabled",
} as const;

/**
 * Validate that all required secrets are present in the environment.
 * Logs the NAMES of missing secrets, never their values.
 * Throws an error if validation fails.
 */
export function validateSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const missing: string[] = [];

  // Check required secrets
  for (const secret of REQUIRED_SECRETS) {
    if (!env[secret]) {
      missing.push(secret);
    }
  }

  if (missing.length > 0) {
    console.error(
      `[worker-service] Missing required environment secrets: ${missing.join(", ")}. ` +
        "Set these variables and try again."
    );
    throw new Error(`Missing required secrets: ${missing.join(", ")}`);
  }

  // Check conditional secrets
  // If either attestor secret is set, both must be set
  const hasAttestorSecret = !!env.ATTESTOR_SECRET_KEY;
  const hasRegistryId = !!env.ATTESTATION_REGISTRY_ID;

  if (hasAttestorSecret && !hasRegistryId) {
    console.error(
      "[worker-service] ATTESTOR_SECRET_KEY is set but ATTESTATION_REGISTRY_ID is missing. " +
        "Set both or neither."
    );
    throw new Error("Incomplete attestor configuration");
  }

  if (hasRegistryId && !hasAttestorSecret) {
    console.error(
      "[worker-service] ATTESTATION_REGISTRY_ID is set but ATTESTOR_SECRET_KEY is missing. " +
        "Set both or neither."
    );
    throw new Error("Incomplete attestor configuration");
  }

  // Log success
  console.info(
    `[worker-service] All ${REQUIRED_SECRETS.length} required secrets validated successfully.`
  );

  // Log optional features
  if (hasAttestorSecret && hasRegistryId) {
    console.info("[worker-service] Attestor secrets configured (on-chain attestation enabled).");
  } else {
    console.info(
      "[worker-service] Attestor secrets not configured (on-chain attestation disabled)."
    );
  }
}

/**
 * Check that a secret value is present without exposing its value in the log.
 * Returns true if the secret is set, false otherwise.
 * Never logs the secret value.
 */
export function isSecretSet(secretName: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env[secretName];
}

/**
 * Get the length of a secret value without exposing the value itself.
 * Useful for validation (e.g., checking if a key has the right length).
 * Never logs the secret value.
 */
export function getSecretLength(secretName: string, env: NodeJS.ProcessEnv = process.env): number {
  const value = env[secretName];
  return value ? value.length : 0;
}
