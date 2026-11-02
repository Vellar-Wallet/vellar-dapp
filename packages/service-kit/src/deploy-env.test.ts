import { describe, expect, it } from "vitest";
import {
  assertDeployEnvPolicy,
  DeployEnvPolicyError,
  deployEnvFromEnv,
  deployEnvViolations,
} from "./deploy-env";

// Staging tier policy (catalogue 1.4). DEPLOY_ENV=staging is an ASSERTION OF
// INTENT: the process is a staging stack and must be unable to touch mainnet,
// production data or production-only escape hatches. Unset means production and
// adds no rules (so existing deployments are untouched).

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

/** A fully valid staging environment; each test breaks exactly one thing. */
const goodStaging = (): NodeJS.ProcessEnv => ({
  DEPLOY_ENV: "staging",
  STELLAR_NETWORK: "testnet",
  STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  STELLAR_NETWORK_PASSPHRASE: TESTNET_PASSPHRASE,
  DATABASE_URL: "postgres://staging-user:pw@staging-db.internal:5432/vellar_staging",
  CORS_ORIGIN: "https://staging.vellar.xyz",
});

describe("deployEnvFromEnv", () => {
  it("defaults to production when DEPLOY_ENV is unset or blank", () => {
    expect(deployEnvFromEnv({})).toBe("production");
    expect(deployEnvFromEnv({ DEPLOY_ENV: "" })).toBe("production");
    expect(deployEnvFromEnv({ DEPLOY_ENV: "  " })).toBe("production");
  });

  it.each(["staging", "production", "development"] as const)("accepts %s", (value) => {
    expect(deployEnvFromEnv({ DEPLOY_ENV: value })).toBe(value);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(deployEnvFromEnv({ DEPLOY_ENV: " Staging " })).toBe("staging");
  });

  it("an unknown value throws instead of guessing", () => {
    expect(() => deployEnvFromEnv({ DEPLOY_ENV: "stage" })).toThrow(DeployEnvPolicyError);
    expect(() => deployEnvFromEnv({ DEPLOY_ENV: "prod" })).toThrow(/DEPLOY_ENV/);
  });
});

describe("deployEnvViolations (staging)", () => {
  it("a valid staging environment has no violations", () => {
    expect(deployEnvViolations(goodStaging())).toEqual([]);
  });

  it("production and development have no violations whatever they contain", () => {
    for (const DEPLOY_ENV of ["production", "development"]) {
      expect(
        deployEnvViolations({ DEPLOY_ENV, STELLAR_NETWORK: "mainnet", ALLOW_INMEMORY: "1" }),
      ).toEqual([]);
    }
    expect(deployEnvViolations({ STELLAR_NETWORK: "mainnet" })).toEqual([]); // unset = production
  });

  describe("network is pinned to testnet", () => {
    it("rejects STELLAR_NETWORK=mainnet", () => {
      expect(deployEnvViolations({ ...goodStaging(), STELLAR_NETWORK: "mainnet" })).toEqual([
        expect.stringContaining("STELLAR_NETWORK must be 'testnet'"),
      ]);
    });

    it("rejects an unset STELLAR_NETWORK (staging never infers a network)", () => {
      const env = goodStaging();
      delete env.STELLAR_NETWORK;
      expect(deployEnvViolations(env)).toEqual([
        expect.stringContaining("STELLAR_NETWORK must be 'testnet'"),
      ]);
    });

    it("rejects a mainnet passphrase even when STELLAR_NETWORK says testnet", () => {
      const v = deployEnvViolations({
        ...goodStaging(),
        STELLAR_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE,
      });
      expect(v.join(" ")).toMatch(/passphrase looks like mainnet/);
    });

    it("rejects a mainnet RPC even when STELLAR_NETWORK says testnet", () => {
      const v = deployEnvViolations({
        ...goodStaging(),
        STELLAR_RPC_URL: "https://mainnet.sorobanrpc.com",
      });
      expect(v.join(" ")).toMatch(/RPC host.*looks like mainnet/);
    });

    it("accepts unset passphrase and RPC (testnet defaults apply)", () => {
      const env = goodStaging();
      delete env.STELLAR_RPC_URL;
      delete env.STELLAR_NETWORK_PASSPHRASE;
      expect(deployEnvViolations(env)).toEqual([]);
    });
  });

  describe("its own database, never in-memory", () => {
    it("requires DATABASE_URL", () => {
      const env = goodStaging();
      delete env.DATABASE_URL;
      expect(deployEnvViolations(env)).toEqual([
        expect.stringContaining("DATABASE_URL is required"),
      ]);
    });

    it("rejects a blank DATABASE_URL", () => {
      expect(deployEnvViolations({ ...goodStaging(), DATABASE_URL: "  " })).toHaveLength(1);
    });

    it("rejects staging pointed at the production database when PRODUCTION_DATABASE_URL is known", () => {
      const prod = "postgres://prod:pw@prod-db.internal:5432/vellar";
      const v = deployEnvViolations({
        ...goodStaging(),
        DATABASE_URL: prod,
        PRODUCTION_DATABASE_URL: prod,
      });
      expect(v.join(" ")).toMatch(/same database as production/i);
    });

    it("does not leak the connection string into the message", () => {
      const prod = "postgres://prod:s3cretpw@prod-db.internal:5432/vellar";
      const v = deployEnvViolations({
        ...goodStaging(),
        DATABASE_URL: prod,
        PRODUCTION_DATABASE_URL: prod,
      });
      expect(v.join(" ")).not.toContain("s3cretpw");
    });
  });

  describe("production escape hatches are unset", () => {
    it.each(["ALLOW_INMEMORY", "ALLOW_SINGLE_KEY_ATTESTOR"])("rejects %s=1", (name) => {
      const v = deployEnvViolations({ ...goodStaging(), [name]: "1" });
      expect(v).toEqual([expect.stringContaining(name)]);
    });

    it.each(["1", "true", "yes", "on", "anything"])("treats %j as set", (value) => {
      expect(deployEnvViolations({ ...goodStaging(), ALLOW_INMEMORY: value })).toHaveLength(1);
    });

    it.each(["", "0", "false", " FALSE "])("treats %j as unset", (value) => {
      expect(deployEnvViolations({ ...goodStaging(), ALLOW_INMEMORY: value })).toEqual([]);
    });
  });

  describe("CORS must not allow production origins", () => {
    it.each([
      "https://vellar.xyz",
      "https://www.vellar.xyz",
      "https://app.vellar.xyz",
      "https://staging.vellar.xyz,https://vellar.xyz",
      "https://vellar.xyz/",
      "HTTPS://VELLAR.XYZ",
    ])("rejects %s", (CORS_ORIGIN) => {
      const v = deployEnvViolations({ ...goodStaging(), CORS_ORIGIN });
      expect(v.join(" ")).toMatch(/CORS_ORIGIN/);
    });

    it("requires CORS_ORIGIN to be set explicitly", () => {
      const env = goodStaging();
      delete env.CORS_ORIGIN;
      expect(deployEnvViolations(env).join(" ")).toMatch(/CORS_ORIGIN is required/);
    });

    it("accepts staging and preview origins", () => {
      expect(
        deployEnvViolations({
          ...goodStaging(),
          CORS_ORIGIN: "https://staging.vellar.xyz,https://vellar-dapp-git-staging.vercel.app",
        }),
      ).toEqual([]);
    });
  });

  it("reports EVERY violation at once, not just the first", () => {
    const v = deployEnvViolations({
      DEPLOY_ENV: "staging",
      STELLAR_NETWORK: "mainnet",
      ALLOW_INMEMORY: "1",
      ALLOW_SINGLE_KEY_ATTESTOR: "1",
      CORS_ORIGIN: "https://vellar.xyz",
    });
    expect(v.length).toBeGreaterThanOrEqual(5);
  });
});

describe("assertDeployEnvPolicy", () => {
  it("returns the environment for a valid staging config", () => {
    expect(assertDeployEnvPolicy(goodStaging())).toBe("staging");
  });

  it("returns production without checking anything when unset", () => {
    expect(assertDeployEnvPolicy({ STELLAR_NETWORK: "mainnet" })).toBe("production");
  });

  it("throws one DeployEnvPolicyError naming every violation", () => {
    let error: unknown;
    try {
      assertDeployEnvPolicy({ ...goodStaging(), STELLAR_NETWORK: "mainnet", ALLOW_INMEMORY: "1" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DeployEnvPolicyError);
    expect((error as DeployEnvPolicyError).violations).toHaveLength(2);
    expect((error as Error).message).toContain("STELLAR_NETWORK");
    expect((error as Error).message).toContain("ALLOW_INMEMORY");
  });
});

// Every service entrypoint must enforce the policy, or a staging stack could run
// a mainnet service the policy never saw. The entrypoints are top-level-await
// scripts that cannot be imported in a unit test, so this pins the call site
// directly and the boot test in wallet-service proves it actually exits.
describe("every service entrypoint enforces the staging policy", () => {
  const services = [
    "wallet-service",
    "lifecycle-service",
    "policy-service",
    "verification-service",
    "api-gateway",
    "worker-service",
  ];

  it.each(services)("%s calls enforceDeployEnvPolicy before its other setup", async (service) => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL(`../../../services/${service}/src/index.ts`, import.meta.url),
      "utf8",
    );
    const call = source.indexOf(`enforceDeployEnvPolicy("${service}")`);
    expect(
      call,
      `${service}/src/index.ts must call enforceDeployEnvPolicy("${service}")`,
    ).toBeGreaterThan(-1);
    // Before the first real work. Matching "name(" skips the import lines.
    for (const work of ["configFromEnv(", "startService(", "buildServer(", "connectDb("]) {
      const at = source.indexOf(work);
      if (at !== -1) expect(call, `${work} runs before the policy in ${service}`).toBeLessThan(at);
    }
  });
});
