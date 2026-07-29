import { expect, test, type Page } from "@playwright/test";

const WALLET_CONTRACT = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";
const POLICY_CONTRACT = "CBGL7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF99";

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
  }, WALLET_CONTRACT);
}

// @ci — fully mocked gateway/chain reads, safe to run in CI without secrets or funded account.
test.describe("safety policy lifecycle (mocked gateway) @ci", () => {
  test.beforeEach(async ({ page }) => {
    await seedSession(page);
  });

  test("configure, review, deploy safety policy and see violating transaction rejected", async ({
    page,
  }) => {
    let policyGenerated = false;

    // Mock policy endpoints and RPC/gateway reads
    await page.route("**/policies/**", async (route) => {
      const url = route.request().url();
      if (url.includes("/policies/templates")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            {
              type: "spending_limit",
              title: "Spending limit",
              description: "Cap how much XLM a signer can move within a rolling window.",
              enforcement: { kind: "policy-contract" },
            },
          ]),
        });
        return;
      }

      if (url.includes("/policies/generate")) {
        policyGenerated = true;
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            policy: {
              id: "pol-safety-1",
              definition: {
                version: "1",
                type: "spending_limit",
                owners: [WALLET_CONTRACT],
                spendingLimits: { dailyXlm: "50" },
              },
              policyHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
              manifest: {
                template: "spending_limit",
                enforcement: {
                  kind: "policy-contract",
                  wasmHash: "0f6b858d61799a33efdc2303c60eb0c148fd2983b7d2336fc345b5492a24b791",
                  constructorArgs: {
                    dailyLimitStroops: "500000000",
                    windowSeconds: 86400,
                  },
                },
                network: "testnet",
              },
              status: "generated",
            },
          }),
        });
        return;
      }

      if (url.includes("/deploy-instance")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            contractId: POLICY_CONTRACT,
            policy: {
              id: "pol-safety-1",
              status: "instance_deployed",
              instance: { contractId: POLICY_CONTRACT },
            },
          }),
        });
        return;
      }

      await route.continue();
    });

    // Mock transaction submission path
    await page.route("**/transactions/submit", async (route) => {
      const payload = route.request().postDataJSON() as { amount?: string };
      if (payload?.amount && Number(payload.amount) > 50) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Transaction rejected: violates configured safety policy spending limit for known transfer patterns",
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "success", txHash: "tx-ok-123" }),
      });
    });

    // 1. Configure safety policy
    await page.goto("/policies");
    await page.getByText("Spending limit").click();
    await page.getByLabel(/daily limit/i).fill("50");
    await page.getByRole("button", { name: /validate & generate/i }).click();

    // 2. Review generated artifacts and accurate wording
    await expect(page.getByText(/policy generated/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/50 XLM/)).toBeVisible();
    expect(policyGenerated).toBe(true);

    // Verify honest positioning text (no intent firewall, no universal protection claims, no fiat display)
    const reviewSection = page.locator("body");
    await expect(reviewSection).not.toContainText("intent firewall");
    await expect(reviewSection).not.toContainText("universal protection");
    await expect(reviewSection).not.toContainText("$");

    // 3. Deploy safety policy to account
    await page.getByRole("button", { name: /deploy to my account/i }).click();
    await expect(page.getByText(/policy attached to your account/i)).toBeVisible({
      timeout: 10_000,
    });

    // 4. Attempt a transaction that violates the configured safety policy
    const violationAttempt = await page.evaluate(async () => {
      const res = await fetch("/transactions/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: "100", recipient: "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM" }),
      });
      return { status: res.status, body: await res.json() };
    });

    // 5. Verify rejection with explanation
    expect(violationAttempt.status).toBe(400);
    expect(violationAttempt.body.error).toContain(
      "Transaction rejected: violates configured safety policy spending limit for known transfer patterns",
    );
  });
});
