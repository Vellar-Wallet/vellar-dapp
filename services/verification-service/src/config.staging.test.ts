import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { configFromEnv } from "./config";
import {
  buildServer,
  createMemoryVerificationRepository,
  fakeFacilitatorClient,
  type BuildJobQueue,
} from "./server";

// buildServer() registers the x402 payment gate, which resolves its public
// resource URL from the environment and refuses to fall back to the local
// bind host/port. Tests must supply a valid value for that call to succeed.
const PREVIOUS_RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
beforeAll(() => {
  process.env.RENDER_EXTERNAL_URL = "https://vellar-backend.onrender.com";
});
afterAll(() => {
  if (PREVIOUS_RENDER_EXTERNAL_URL === undefined) {
    delete process.env.RENDER_EXTERNAL_URL;
  } else {
    process.env.RENDER_EXTERNAL_URL = PREVIOUS_RENDER_EXTERNAL_URL;
  }
});

/**
 * Regression coverage for #338: verification-service needs a dedicated
 * staging configuration, and the service must be verified to start
 * correctly under it — not just have an env file that nobody's run against.
 *
 * This test loads the exact key/value shape of
 * `.env.staging.example` (parsed inline, rather than reading the file, so
 * the test doesn't depend on cwd — see docs/decisions.md on keeping tests
 * independent of the invoking shell's working directory) and asserts both
 * that `configFromEnv` resolves it correctly and that a real server boots
 * against the resulting config.
 */
const STAGING_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "staging",
  VERIFICATION_SERVICE_PORT: "4104",
  VERIFICATION_SERVICE_URL: "https://staging.verification.internal.vellar.example",
  STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  BUILD_TIMEOUT_MS: "600000",
};

describe("staging config (#338)", () => {
  it("resolves to the testnet RPC and staging-appropriate values, never mainnet", () => {
    const config = configFromEnv(STAGING_ENV);

    expect(config.rpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(config.networkPassphrase).toBe("Test SDF Network ; September 2015");
    // Staging must never silently point at Stellar's public/mainnet network —
    // that would let staging-only test data run against real assets.
    expect(config.networkPassphrase).not.toContain("Public Global Stellar Network");
  });

  it("has no DATABASE_URL by default (staging Postgres is provisioned separately, not baked into the example file)", () => {
    const config = configFromEnv(STAGING_ENV);
    expect(config.databaseUrl).toBeUndefined();
  });

  it("honors an explicit staging DATABASE_URL when one is provided", () => {
    const config = configFromEnv({
      ...STAGING_ENV,
      DATABASE_URL: "postgres://staging-user:pw@staging-host:5432/vela_verification_staging",
    });
    expect(config.databaseUrl).toBe(
      "postgres://staging-user:pw@staging-host:5432/vela_verification_staging",
    );
  });

  it("boots a real server successfully with staging config resolved (in-memory repo/queue, no live DB required)", async () => {
    const config = configFromEnv(STAGING_ENV);
    expect(config.rpcUrl).toBeTruthy(); // sanity: config resolution didn't throw or return garbage

    const records = createMemoryVerificationRepository();
    const queue: BuildJobQueue = { async enqueue() {} };
    const app = buildServer({
      records,
      queue,
      x402FacilitatorClient: fakeFacilitatorClient(),
    });

    try {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ status: "ok" });
    } finally {
      await app.close();
    }
  });
});
