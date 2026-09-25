import { expect, test, type Page, type Request } from "@playwright/test";
import fixture from "./fixtures/policy-deploy.json";

// e2e: "deploy policy" (idea.md §15), CI-safe half. The live-testnet half —
// the passkey-signed kit.addPolicy attach and the L1-verified record — is in
// policy.spec.ts and needs a sponsor key + funded wallet (see e2e/README.md).
//
// Every API response here is REPLAYED from fixtures/policy-deploy.json, which
// is captured from the real policy-service routes and drift-checked by
// services/policy-service/src/e2e-fixtures.test.ts (security-audit.md RA-9: no
// hand-written response shapes). The page, the vellar-sdk policy client and
// the real passkey-kit runtime are all unmocked.
//
// What this proves, beyond "no error was thrown":
//   - the page sends the exact definition the user configured (owner = the
//     signed-in account, dailyXlm = what was typed) and the right wallet to
//     simulate + deploy-instance;
//   - the review shows the server's content hash and the honest cap copy;
//   - every failure stops the flow BEFORE later steps (no instance deploy after
//     a failed dry-run, no attach after a failed instance deploy) and the page
//     never claims "Policy attached" or records a deployment it didn't make —
//     the L1 finding was exactly this path reporting unconfirmed success.

const API = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const WALLET = fixture.wallet;

type Reply = { status: number; body: unknown };

async function seedSession(page: Page) {
  await page.addInitScript((accountId) => {
    window.localStorage.setItem(
      "vellar.session",
      JSON.stringify({
        accountId,
        network: "testnet",
        connected: true,
        authMethod: "passkey",
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      }),
    );
  }, WALLET);
}

/**
 * Route the policy API to fixture replies. `overrides` swaps individual steps
 * for a captured failure. Returns the requests the page actually made, in order.
 */
async function mockPolicyApi(page: Page, overrides: Partial<Record<Step, Reply>> = {}) {
  const replies: Record<Step, Reply> = {
    templates: fixture.templates,
    validate: fixture.validate,
    generate: fixture.generate,
    simulate: fixture.simulateOk,
    "deploy-instance": fixture.deployInstanceOk,
    // /policies/deploy (the record step) must never be reached in CI: the
    // attach needs a real passkey-connected wallet. Answer loudly if it is.
    deploy: { status: 599, body: { error: "record_reached_in_ci" } },
    ...overrides,
  };
  const calls: { step: Step; body: unknown }[] = [];
  await page.route(
    (url) => url.href.startsWith(`${API}/policies/`),
    async (route) => {
      const step = stepOf(route.request());
      calls.push({ step, body: route.request().postDataJSON() });
      const reply = replies[step];
      await route.fulfill({
        status: reply.status,
        contentType: "application/json",
        body: JSON.stringify(reply.body),
      });
    },
  );
  return calls;
}

type Step = "templates" | "validate" | "generate" | "simulate" | "deploy-instance" | "deploy";

function stepOf(req: Request): Step {
  const path = new URL(req.url()).pathname.replace(/^\/policies\//, "");
  if (path === "templates" || path === "validate" || path === "generate" || path === "deploy") {
    return path;
  }
  if (path.endsWith("/simulate")) return "simulate";
  if (path.endsWith("/deploy-instance")) return "deploy-instance";
  throw new Error(`unexpected policy API call: ${req.method()} ${req.url()}`);
}

async function configureSpendingLimit(page: Page, dailyXlm: string) {
  await page.goto("/policies");
  // The builder is behind the policyBuilderV2 rollout flag; playwright.config
  // enables it for the dev server it starts. A reused server started without
  // it shows the "not in the rollout" copy instead — fail with that reason.
  await expect(
    page.getByText("Spending limit", { exact: true }),
    "policy builder not visible — start the dev server with NEXT_PUBLIC_FLAG_POLICY_BUILDER_V2_ROLLOUT_PERCENT=100 (see e2e/README.md)",
  ).toBeVisible({ timeout: 30_000 });
  await page.getByText("Spending limit", { exact: true }).click();
  await page.getByLabel(/daily limit/i).fill(dailyXlm);
  await page.getByRole("button", { name: /validate & generate/i }).click();
}

// The page's own error line — Next's route announcer is also role="alert".
const pageAlert = (page: Page) => page.locator('p[role="alert"]');

const attachedBanner = (page: Page) => page.getByText(/policy attached to your account/i);

// @ci — fully mocked (no backend/secrets), safe to run in CI.
test.describe("deploy policy (fixtures captured from policy-service) @ci", () => {
  test.beforeEach(async ({ page }) => {
    await seedSession(page);
  });

  test("configure → review → simulate → instance deploy; stops at the passkey attach without claiming success", async ({
    page,
  }) => {
    const calls = await mockPolicyApi(page);
    await configureSpendingLimit(page, "10");

    // Review: the server's generated record, not the page's echo of the input.
    await expect(page.getByText(/policy generated/i)).toBeVisible();
    const generated = fixture.generate.body.policy;
    await expect(page.getByText(generated.policyHash)).toBeVisible();
    await expect(page.getByText(/up to\s*10 XLM\s*total per 24-hour period/i)).toBeVisible();

    // The page sent exactly what the user configured, for the signed-in account.
    expect(calls.find((c) => c.step === "validate")?.body).toEqual(fixture.definition);
    expect(calls.find((c) => c.step === "generate")?.body).toEqual({
      definition: fixture.definition,
      network: "testnet",
    });

    await page.getByRole("button", { name: /deploy to my account/i }).click();

    // The seeded session has no passkey keyId, so the real passkey-kit runtime
    // refuses to build the attach (wallet not connected). That refusal is the
    // correct outcome: the flow must surface it and must NOT record a deploy.
    await expect(pageAlert(page)).toHaveText(/connected wallet is required/i, { timeout: 30_000 });
    await expect(attachedBanner(page)).toHaveCount(0);

    // (templates may load twice under React strict mode in dev — not a step.)
    expect(calls.map((c) => c.step).filter((s) => s !== "templates")).toEqual([
      "validate",
      "generate",
      "simulate",
      "deploy-instance",
    ]);
    expect(calls.find((c) => c.step === "simulate")?.body).toEqual({ wallet: WALLET });
    expect(calls.find((c) => c.step === "deploy-instance")?.body).toEqual({ wallet: WALLET });
  });

  test("server validation rejects the definition → errors shown, nothing generated", async ({
    page,
  }) => {
    const calls = await mockPolicyApi(page, { validate: fixture.validateRejected });
    await configureSpendingLimit(page, "ten");

    for (const message of fixture.validateRejected.body.errors) {
      await expect(page.getByText(message)).toBeVisible();
    }
    await expect(page.getByText(/policy generated/i)).toHaveCount(0);
    expect(calls.find((c) => c.step === "validate")?.body).toEqual(fixture.invalidDefinition);
    expect(calls.some((c) => c.step === "generate")).toBe(false);
  });

  test("dry-run fails → error shown, no instance deployed, no passkey prompt", async ({ page }) => {
    const calls = await mockPolicyApi(page, { simulate: fixture.simulateRejected });
    await configureSpendingLimit(page, "10");
    await page.getByRole("button", { name: /deploy to my account/i }).click();

    await expect(pageAlert(page)).toHaveText(fixture.simulateRejected.body.error);
    await expect(page.getByText(/approve in your passkey/i)).toHaveCount(0);
    await expect(attachedBanner(page)).toHaveCount(0);
    expect(calls.some((c) => c.step === "deploy-instance")).toBe(false);
    // The deploy button is usable again (the user can retry).
    await expect(page.getByRole("button", { name: /deploy to my account/i })).toBeEnabled();
  });

  test("on-chain instance deploy fails → error shown, never attached or recorded", async ({
    page,
  }) => {
    const calls = await mockPolicyApi(page, { "deploy-instance": fixture.deployInstanceFailed });
    await configureSpendingLimit(page, "10");
    await page.getByRole("button", { name: /deploy to my account/i }).click();

    await expect(pageAlert(page)).toHaveText(fixture.deployInstanceFailed.body.error);
    await expect(page.getByText(/approve in your passkey/i)).toHaveCount(0);
    await expect(attachedBanner(page)).toHaveCount(0);
    expect(calls.some((c) => c.step === "deploy")).toBe(false);
    await expect(page.getByRole("button", { name: /deploy to my account/i })).toBeEnabled();
  });

  test("no sponsor configured (503) → honest error, nothing deployed", async ({ page }) => {
    const calls = await mockPolicyApi(page, { simulate: fixture.simulateUnavailable });
    await configureSpendingLimit(page, "10");
    await page.getByRole("button", { name: /deploy to my account/i }).click();

    await expect(pageAlert(page)).toHaveText(fixture.simulateUnavailable.body.error);
    await expect(attachedBanner(page)).toHaveCount(0);
    expect(calls.some((c) => c.step === "deploy-instance")).toBe(false);
  });
});
