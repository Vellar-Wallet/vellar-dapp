import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import { SigningKeyConfigError, signingKeyFromEnv, verifySigningKeys } from "@vellar/service-kit";
import { buildServer, createMemoryPolicyRepository } from "./server";

// #755: policy-service must never write CSRF_SECRET, RELAYER_API_KEY or
// SPONSOR_SECRET_KEY to its logs — not in normal operation at debug level, and
// not in the error messages printed when boot fails (the place a raw secret most
// often leaks by accident). Each secret is a unique random sentinel, so a hit in
// any log line can only be that secret.
//
// Follow-up (deliberately not in scope here): wallet-service and worker-service
// read the same kinds of secrets at boot (`SPONSOR_SECRET_KEY`, `RELAYER_API_KEY`,
// `ATTESTOR_SECRET_KEY`). This file is the pattern to copy for them if a gap shows
// up there; policy-service is the only service covered so far.

const unique = () => randomBytes(8).toString("hex");
const CSRF_SECRET = `csrf-secret-${unique()}`;
const RELAYER_API_KEY = `relayer-api-key-${unique()}`;
const SPONSOR = Keypair.random();
const SPONSOR_SECRET_KEY = SPONSOR.secret();

const SECRETS = { CSRF_SECRET, RELAYER_API_KEY, SPONSOR_SECRET_KEY } as const;

/** Every form a secret could plausibly appear in inside a log line. */
function forms(secret: string): string[] {
  return [
    secret,
    Buffer.from(secret).toString("base64"),
    Buffer.from(secret).toString("hex"),
    encodeURIComponent(secret),
  ];
}

/** Names of the secrets that appear (in any form) anywhere in `text`. */
function leaks(text: string): string[] {
  return Object.entries(SECRETS)
    .filter(([, secret]) => forms(secret).some((form) => text.includes(form)))
    .map(([name]) => name);
}

function captureLogs() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(...String(chunk).split("\n").filter(Boolean));
      callback();
    },
  });
  return { lines, stream };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  await app?.close();
  app = undefined;
});

function stubSecretsInEnv() {
  vi.stubEnv("CSRF_SECRET", CSRF_SECRET);
  vi.stubEnv("RELAYER_API_KEY", RELAYER_API_KEY);
  vi.stubEnv("SPONSOR_SECRET_KEY", SPONSOR_SECRET_KEY);
}

// Headers a client (or the relayer integration) could send that carry secrets.
const secretHeaders = {
  authorization: `Bearer ${RELAYER_API_KEY}`,
  "x-api-key": RELAYER_API_KEY,
  "x-csrf-token": `forged.${Date.now()}.${CSRF_SECRET}`,
  cookie: `sponsor=${SPONSOR_SECRET_KEY}`,
};

describe("the capture itself works (so a clean result means something)", () => {
  it("records debug-level lines when the logger is set to debug", async () => {
    const { lines, stream } = captureLogs();
    app = buildServer({ logger: { level: "debug", stream } });
    await app.ready();

    app.log.debug({ probe: "debug-probe" }, "capture check");

    expect(lines.some((line) => line.includes("debug-probe") && line.includes('"level":20'))).toBe(
      true,
    );
  });

  it("detects a secret that IS logged, in raw and encoded forms", async () => {
    const { lines, stream } = captureLogs();
    app = buildServer({ csrfSecret: CSRF_SECRET, logger: { level: "debug", stream } });
    await app.ready();

    app.log.info(`oops ${CSRF_SECRET}`);
    app.log.info({ b64: Buffer.from(RELAYER_API_KEY).toString("base64") }, "oops");
    app.log.warn({ url: `https://x.test/?k=${encodeURIComponent(SPONSOR_SECRET_KEY)}` }, "oops");

    expect(leaks(lines.join("\n")).sort()).toEqual(
      ["CSRF_SECRET", "RELAYER_API_KEY", "SPONSOR_SECRET_KEY"].sort(),
    );
  });
});

describe("policy-service logging at debug level", () => {
  it("writes no secret while booting and serving requests (CSRF secret from env)", async () => {
    stubSecretsInEnv();
    const { lines, stream } = captureLogs();
    // No csrfSecret dependency: the server reads CSRF_SECRET from the environment.
    app = buildServer({ logger: { level: "debug", stream } });
    await app.ready();

    const csrf = await app.inject({ method: "GET", url: "/csrf-token" });
    await app.inject({ method: "GET", url: "/health" });
    await app.inject({ method: "GET", url: "/policies/templates" });
    await app.inject({
      method: "POST",
      url: "/policies/validate",
      headers: secretHeaders,
      payload: { not: "a policy" },
    });

    expect(csrf.statusCode).toBe(200);
    expect(lines.length).toBeGreaterThan(0);
    expect(leaks(lines.join("\n"))).toEqual([]);
  });

  it("writes no secret when a CSRF-protected admin request is rejected", async () => {
    stubSecretsInEnv();
    const { lines, stream } = captureLogs();
    app = buildServer({ csrfSecret: CSRF_SECRET, logger: { level: "debug", stream } });
    await app.ready();

    const rejected = await app.inject({
      method: "POST",
      url: "/admin/policies/generate",
      headers: secretHeaders,
      payload: { template: "spending_limit" },
    });

    expect(rejected.statusCode).toBe(403);
    expect(leaks(lines.join("\n"))).toEqual([]);
    expect(leaks(rejected.body)).toEqual([]);
  });

  it("writes no secret when a request handler throws (error path)", async () => {
    stubSecretsInEnv();
    const { lines, stream } = captureLogs();
    const policies = Object.assign(createMemoryPolicyRepository(), {
      find: async () => {
        throw new Error("database unavailable");
      },
    });
    app = buildServer({ csrfSecret: CSRF_SECRET, policies, logger: { level: "debug", stream } });
    await app.ready();

    const failed = await app.inject({
      method: "GET",
      url: "/policies/some-id",
      headers: secretHeaders,
    });

    expect(failed.statusCode).toBeGreaterThanOrEqual(500);
    expect(lines.some((line) => line.includes("database unavailable"))).toBe(true);
    expect(leaks(lines.join("\n"))).toEqual([]);
    expect(leaks(failed.body)).toEqual([]);
  });

  it("does not echo the request headers it was sent into the logs", async () => {
    const { lines, stream } = captureLogs();
    app = buildServer({ csrfSecret: CSRF_SECRET, logger: { level: "debug", stream } });
    await app.ready();

    await app.inject({ method: "GET", url: "/policies/templates", headers: secretHeaders });

    const logged = lines.join("\n");
    expect(logged).not.toContain("authorization");
    expect(logged).not.toContain("x-api-key");
    expect(logged).not.toContain("cookie");
  });
});

// ── Boot failure paths ────────────────────────────────────────────────────

describe("boot failure messages (function level)", () => {
  const sponsorEnv = (overrides: Record<string, string>) => ({
    SPONSOR_SECRET_KEY,
    SPONSOR_PUBLIC_KEY: Keypair.random().publicKey(),
    ...overrides,
  });
  const verify = (env: Record<string, string>, relayerBaseUrl?: string) =>
    verifySigningKeys({
      network: "testnet",
      keys: [signingKeyFromEnv("sponsor", env)],
      derivePublicKey: (secret) => Keypair.fromSecret(secret).publicKey(),
      relayerBaseUrl,
    });

  function messageOf(run: () => unknown): string {
    try {
      run();
    } catch (err) {
      expect(err).toBeInstanceOf(SigningKeyConfigError);
      return (err as Error).message;
    }
    throw new Error("expected the boot check to throw");
  }

  it("a sponsor secret that does not match its pinned public key prints no secret", () => {
    const message = messageOf(() => verify(sponsorEnv({})));
    expect(message).toContain("SPONSOR_SECRET_KEY signs as");
    expect(message).toContain(SPONSOR.publicKey()); // public keys are fine to print
    expect(leaks(message)).toEqual([]);
  });

  it("an unparseable sponsor secret is not echoed back", () => {
    const garbage = `garbage-seed-${unique()}`;
    const message = messageOf(() => verify(sponsorEnv({ SPONSOR_SECRET_KEY: garbage })));
    expect(message).toContain("not a valid Stellar secret seed");
    expect(message).not.toContain(garbage);
  });

  it("a wrong-network relayer URL is printed without its credentials or query string", () => {
    const relayerUrl = `https://svc:${RELAYER_API_KEY}@relay.example.com/mainnet/v1?api_key=${RELAYER_API_KEY}`;
    const matchingPin = sponsorEnv({ SPONSOR_PUBLIC_KEY: SPONSOR.publicKey() });
    const message = messageOf(() => verify(matchingPin, relayerUrl));
    expect(message).toContain("https://relay.example.com/mainnet/v1");
    expect(leaks(message)).toEqual([]);
  });
});

describe("boot failure of the real entrypoint (child process)", () => {
  const serviceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  /** Boots `src/index.ts` with the given env and returns everything it printed. */
  function boot(env: Record<string, string>) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: serviceDir,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_ENV: "test",
        ALLOW_INMEMORY: "1",
        STELLAR_NETWORK: "testnet",
        LOG_LEVEL: "debug",
        CSRF_SECRET,
        RELAYER_API_KEY,
        ...env,
      },
    });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  }

  it("refuses to boot on a pin mismatch and prints no secret", () => {
    const { status, output } = boot({
      SPONSOR_SECRET_KEY,
      SPONSOR_PUBLIC_KEY: Keypair.random().publicKey(),
    });

    expect(status).toBe(1);
    expect(output).toContain("[policy-service]");
    expect(output).toContain("does not match");
    expect(leaks(output)).toEqual([]);
  }, 90_000);

  it("refuses to boot on an unparseable sponsor secret and does not echo it", () => {
    const garbage = `garbage-seed-${unique()}`;
    const { status, output } = boot({ SPONSOR_SECRET_KEY: garbage });

    expect(status).not.toBe(0);
    expect(output).not.toContain(garbage);
    expect(leaks(output)).toEqual([]);
  }, 90_000);
});
