import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PolicyDeployError, type PolicyDeployer, type SimulateResult } from "./deploy";
import { buildServer, createMemoryPolicyRepository } from "./server";

// Source of truth for the web app's mocked "deploy policy" e2e fixtures
// (apps/web/e2e/fixtures/policy-deploy.json, consumed by
// apps/web/e2e/policy-deploy.ci.spec.ts).
//
// security-audit.md RA-9: a fixture must be what the REAL producer emits, not
// what the consumer happens to parse. So every response in that file is
// captured here from the real policy-service `buildServer` (real routes, real
// validation, real template registry, real error mapping). Only the on-chain
// PolicyDeployer is faked — it is the one piece that needs a sponsor key and a
// live RPC — and it is typed against the real `PolicyDeployer` interface.
//
// This test is also the DRIFT GUARD: if a route's status code or body shape
// changes, the comparison below fails until the fixture is regenerated with
//   UPDATE_E2E_FIXTURES=1 pnpm --filter @vellar/policy-service test e2e-fixtures
// and the e2e spec is re-run against it.

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/web/e2e/fixtures/policy-deploy.json",
);

// The smart account the e2e spec seeds as the signed-in session, and the
// policy contract instance the fake deployer "deploys" for it.
export const E2E_WALLET = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";
export const E2E_POLICY_CONTRACT = "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA";
const FIXED_NOW = new Date("2026-09-26T12:00:00.000Z");

// Exactly the definition /policies builds for "Spending limit" with only
// "Daily limit (XLM)" = 10 (app/policies/page.tsx buildDefinition). The e2e
// asserts the page sends this byte-for-byte.
const DEFINITION = {
  version: "1",
  type: "spending_limit",
  owners: [E2E_WALLET],
  spendingLimits: { dailyXlm: "10" },
};

// What the page sends when the user types a non-numeric daily limit — the
// server's validator (not the page) is what rejects it.
const INVALID_DEFINITION = { ...DEFINITION, spendingLimits: { dailyXlm: "ten" } };

// The error string a real Soroban simulation failure carries through
// createPolicyDeployer.simulateInstance (`{ ok: false, error: sim.error }`).
const SIMULATION_ERROR = "HostError: Error(Contract, #2)";

interface Captured {
  status: number;
  body: unknown;
}

function fakeDeployer(behavior: {
  simulate?: () => Promise<SimulateResult>;
  deploy?: () => Promise<{ contractId: string; txHash: string }>;
}): PolicyDeployer {
  return {
    simulateInstance: behavior.simulate ?? (async () => ({ ok: true, minResourceFee: "84372" })),
    deployInstance:
      behavior.deploy ??
      (async () => ({ contractId: E2E_POLICY_CONTRACT, txHash: "e2e-instance-deploy-tx" })),
  };
}

async function capture(deployer?: PolicyDeployer) {
  const app = buildServer({
    policies: createMemoryPolicyRepository(),
    deployer,
    now: () => FIXED_NOW,
  });
  await app.ready();
  const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.json() } satisfies Captured;
  };
  const templates = await call("GET", "/policies/templates");
  const validate = await call("POST", "/policies/validate", DEFINITION);
  const generate = await call("POST", "/policies/generate", {
    definition: DEFINITION,
    network: "testnet",
  });
  const id = (generate.body as { policy: { id: string } }).policy.id;
  return { app, call, id, templates, validate, generate };
}

/** Replace the per-run random policy id so the fixture is stable. */
function stableId<T>(value: T, id: string): T {
  return JSON.parse(JSON.stringify(value).replaceAll(id, "e2e-policy-id")) as T;
}

async function buildFixture() {
  // Happy path up to (not including) the passkey attach.
  const ok = await capture(fakeDeployer({}));
  const simulateOk = await ok.call("POST", `/policies/${ok.id}/simulate`, { wallet: E2E_WALLET });
  const deployInstanceOk = await ok.call("POST", `/policies/${ok.id}/deploy-instance`, {
    wallet: E2E_WALLET,
  });

  // Failure 0: the server's validator rejects the definition before generate.
  const validateRejected = await ok.call("POST", "/policies/validate", INVALID_DEFINITION);

  // Failure 1: the dry-run says the deploy would fail (constructor guard).
  const simFail = await capture(
    fakeDeployer({ simulate: async () => ({ ok: false, error: SIMULATION_ERROR }) }),
  );
  const simulateRejected = await simFail.call("POST", `/policies/${simFail.id}/simulate`, {
    wallet: E2E_WALLET,
  });

  // Failure 2: simulation passes, the real deploy fails on-chain.
  const deployFail = await capture(
    fakeDeployer({
      deploy: async () => {
        throw new PolicyDeployError("Policy deploy failed on-chain", "deploy_failed_onchain");
      },
    }),
  );
  const deployInstanceFailed = await deployFail.call(
    "POST",
    `/policies/${deployFail.id}/deploy-instance`,
    { wallet: E2E_WALLET },
  );

  // Failure 3: no sponsor configured on the server at all.
  const noSponsor = await capture(undefined);
  const simulateUnavailable = await noSponsor.call("POST", `/policies/${noSponsor.id}/simulate`, {
    wallet: E2E_WALLET,
  });

  for (const c of [ok, simFail, deployFail, noSponsor]) await c.app.close();

  return {
    _generatedBy:
      "services/policy-service/src/e2e-fixtures.test.ts (real buildServer; regenerate with UPDATE_E2E_FIXTURES=1)",
    wallet: E2E_WALLET,
    policyContract: E2E_POLICY_CONTRACT,
    definition: DEFINITION,
    invalidDefinition: INVALID_DEFINITION,
    templates: ok.templates,
    validate: ok.validate,
    generate: stableId(ok.generate, ok.id),
    validateRejected,
    simulateOk,
    deployInstanceOk: stableId(deployInstanceOk, ok.id),
    simulateRejected,
    deployInstanceFailed,
    simulateUnavailable,
  };
}

describe("apps/web e2e policy fixtures (RA-9: captured from the real policy-service)", () => {
  it("the fixture file matches what the real routes return today", async () => {
    const fresh = await buildFixture();

    // Sanity: the captured responses are the outcomes the e2e relies on.
    expect(fresh.generate.status).toBe(201);
    expect(fresh.validateRejected.body).toMatchObject({ valid: false });
    expect(fresh.simulateOk.body).toEqual({ ok: true, minResourceFee: "84372" });
    expect(fresh.deployInstanceOk.status).toBe(200);
    expect(fresh.deployInstanceOk.body).toMatchObject({
      contractId: E2E_POLICY_CONTRACT,
      policy: { status: "instance_deployed" },
    });
    expect(fresh.simulateRejected.body).toEqual({ ok: false, error: SIMULATION_ERROR });
    expect(fresh.deployInstanceFailed).toEqual({
      status: 502,
      body: { error: "deploy_failed", code: "deploy_failed_onchain" },
    });
    expect(fresh.simulateUnavailable.status).toBe(503);

    if (process.env.UPDATE_E2E_FIXTURES === "1") {
      mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
      writeFileSync(FIXTURE_PATH, `${JSON.stringify(fresh, null, 2)}\n`);
    }
    const onDisk = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    expect(onDisk).toEqual(fresh);
  });

  it("an unexpected deployer error still answers (never leaves the UI hanging)", async () => {
    const c = await capture(
      fakeDeployer({
        deploy: async () => {
          throw new Error("socket hang up");
        },
      }),
    );
    const res = await c.call("POST", `/policies/${c.id}/deploy-instance`, { wallet: E2E_WALLET });
    await c.app.close();
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "deploy_failed" });
  });
});
