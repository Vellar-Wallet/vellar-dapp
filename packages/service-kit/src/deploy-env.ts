import { resolveNetwork } from "./network-config";

// Deployment-tier policy (catalogue 1.4, staging tier).
//
// DEPLOY_ENV=staging is an ASSERTION OF INTENT: this process is a staging stack
// and must be unable to touch mainnet, the production database or the
// production-only escape hatches. Every service entrypoint calls
// assertDeployEnvPolicy() before it reads any other setting, so a staging
// deployment whose environment drifts toward production refuses to boot instead
// of quietly spending mainnet funds.
//
// DEPLOY_ENV unset means production and adds NO rules, so existing deployments
// are unaffected. The rules only constrain what staging may do.

export type DeployEnv = "production" | "staging" | "development";

export class DeployEnvPolicyError extends Error {
  readonly code = "deploy_env_policy_violation";
  readonly violations: string[];
  constructor(violations: string[]) {
    super(
      `DEPLOY_ENV=staging policy violated (${violations.length}): ` +
        violations.map((v, i) => `${i + 1}) ${v}`).join(" "),
    );
    this.name = "DeployEnvPolicyError";
    this.violations = violations;
  }
}

const TESTNET_RPC = "https://soroban-testnet.stellar.org";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

/** Escape hatches that exist for production edge cases and must never be set on staging. */
const STAGING_FORBIDDEN_FLAGS = ["ALLOW_INMEMORY", "ALLOW_SINGLE_KEY_ATTESTOR"] as const;

/** Hosts of the production web app: staging must not allow them as a CORS origin. */
const PRODUCTION_WEB_HOSTS = new Set(["vellar.xyz", "www.vellar.xyz", "app.vellar.xyz"]);

export function deployEnvFromEnv(env: NodeJS.ProcessEnv): DeployEnv {
  const raw = env.DEPLOY_ENV?.trim().toLowerCase();
  if (!raw) return "production";
  if (raw === "staging" || raw === "production" || raw === "development") return raw;
  throw new DeployEnvPolicyError([
    `DEPLOY_ENV=${JSON.stringify(env.DEPLOY_ENV)} is not valid. Use 'staging', 'production' or 'development' (or leave it unset for production).`,
  ]);
}

/** A flag is "set" unless it is blank, 0 or false (any other value enables it). */
export function flagIsSet(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return !!v && v !== "0" && v !== "false";
}

function networkViolations(env: NodeJS.ProcessEnv): string[] {
  const declared = env.STELLAR_NETWORK?.trim();
  if (declared !== "testnet") {
    return [
      `STELLAR_NETWORK must be 'testnet' on staging (got ${declared ? JSON.stringify(declared) : "unset"}).`,
    ];
  }
  try {
    // Reuse the production cross-check so staging and production agree on what
    // "coherent" means. Unset passphrase/RPC fall back to the testnet defaults.
    resolveNetwork({
      network: "testnet",
      passphrase: env.STELLAR_NETWORK_PASSPHRASE?.trim() || TESTNET_PASSPHRASE,
      rpcUrl: env.STELLAR_RPC_URL?.trim() || TESTNET_RPC,
    });
    return [];
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
}

function databaseViolations(env: NodeJS.ProcessEnv): string[] {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    return ["DATABASE_URL is required on staging (its own Postgres; never in-memory)."];
  }
  // Which TIER the database belongs to is checked against a marker stored IN the database
  // (deployment-marker.ts), not by comparing connection strings: that would need the
  // production credentials inside the staging environment.
  return [];
}

function corsViolations(env: NodeJS.ProcessEnv): string[] {
  const raw = env.CORS_ORIGIN?.trim();
  if (!raw) return ["CORS_ORIGIN is required on staging (explicit staging origins only)."];
  const offending = raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .filter((origin) => {
      try {
        return PRODUCTION_WEB_HOSTS.has(new URL(origin).host.toLowerCase());
      } catch {
        return PRODUCTION_WEB_HOSTS.has(
          origin
            .toLowerCase()
            .replace(/^https?:\/\//, "")
            .replace(/\/+$/, ""),
        );
      }
    });
  return offending.length > 0
    ? [`CORS_ORIGIN must not allow production origins (found ${offending.join(", ")}).`]
    : [];
}

/** Every policy violation for this environment ([] when it is acceptable). */
export function deployEnvViolations(env: NodeJS.ProcessEnv): string[] {
  if (deployEnvFromEnv(env) !== "staging") return [];
  return [
    ...networkViolations(env),
    ...databaseViolations(env),
    ...STAGING_FORBIDDEN_FLAGS.filter((flag) => flagIsSet(env[flag])).map(
      (flag) => `${flag} must be unset on staging (production-only escape hatch).`,
    ),
    ...corsViolations(env),
  ];
}

/** Throws DeployEnvPolicyError listing EVERY violation; returns the environment otherwise. */
export function assertDeployEnvPolicy(env: NodeJS.ProcessEnv): DeployEnv {
  const environment = deployEnvFromEnv(env);
  const violations = deployEnvViolations(env);
  if (violations.length > 0) throw new DeployEnvPolicyError(violations);
  return environment;
}

/**
 * The service-entrypoint form: enforce the policy and EXIT(1) with a readable
 * error naming every violation. Call it before reading any other setting.
 */
export function enforceDeployEnvPolicy(
  service: string,
  env: NodeJS.ProcessEnv = process.env,
): DeployEnv {
  try {
    return assertDeployEnvPolicy(env);
  } catch (err) {
    console.error(`[${service}] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
