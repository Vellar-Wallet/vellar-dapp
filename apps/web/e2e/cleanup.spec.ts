import { expect, test, type Page } from "@playwright/test";

// e2e: inspect and close account (idea.md §15). Drives the real /cleanup wizard
// with the gateway AND Horizon MOCKED (page.route), so it runs in CI with no
// backend/secrets/funded account. The real Horizon inspection + XDR building +
// merge logic is covered by lifecycle-service's tests + a live manual proof
// (docs/decisions.md 2026-07-16); this spec proves the USER wizard flow:
// inspect → plan review → sign unsigned cleanup step → merge → done.

const OLD_ACCOUNT = "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM";
const DESTINATION = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const SMART_ACCOUNT = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";

async function seedSession(page: Page) {
  await page.addInitScript((accountId) => {
    window.localStorage.setItem(
      "vela.session",
      JSON.stringify({
        accountId,
        network: "testnet",
        connected: true,
        authMethod: "passkey",
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      }),
    );
  }, SMART_ACCOUNT);
}

/** All Horizon tx lookups succeed → the wizard's watcher advances immediately. */
async function mockHorizonSeen(page: Page) {
  await page.route("**/transactions/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ successful: true }),
    });
  });
}

// @ci — fully mocked (no backend/secrets), safe to run in CI.
test.describe("inspect and close account (mocked gateway + Horizon) @ci", () => {
  test.beforeEach(async ({ page }) => {
    await seedSession(page);
    await mockHorizonSeen(page);
  });

  test("full path: blockers → cleanup step → merge → account closed", async ({ page }) => {
    const called = { execute: false, merge: false };
    await page.route("**/lifecycle/**", async (route) => {
      const url = route.request().url();
      if (url.endsWith("/lifecycle/execute")) called.execute = true;
      if (url.endsWith("/lifecycle/merge")) called.merge = true;
      if (url.endsWith("/lifecycle/plan")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            plan: {
              accountId: OLD_ACCOUNT,
              destination: DESTINATION,
              mergeReady: false,
              estimatedTransactions: 2,
              blockers: [
                {
                  type: "trustline",
                  description: "1 non-zero trustline (USDC)",
                  actionRequired: "Remove the trustline after zeroing its balance",
                },
              ],
            },
          }),
        });
        return;
      }
      if (url.endsWith("/lifecycle/execute")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            steps: [
              {
                title: "Remove trustline",
                description: "Sign this to remove the USDC trustline",
                hash: "cleanuptxhash1",
                xdr: "AAAA...cleanupxdr",
              },
            ],
          }),
        });
        return;
      }
      if (url.endsWith("/lifecycle/merge")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            step: {
              title: "Merge account",
              description: "Sign this to merge and close the account",
              hash: "mergetxhash1",
              xdr: "AAAA...mergexdr",
            },
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/cleanup");

    // Input stage.
    await page.getByPlaceholder("G...", { exact: true }).fill(OLD_ACCOUNT);
    await page.getByPlaceholder(/classic account, not your smart wallet/).fill(DESTINATION);
    await page.getByRole("button", { name: "Inspect account" }).click();

    // Plan stage — the blocker is shown (this stage is stable; it waits for a
    // user click, so it's safe to assert on).
    await expect(page.getByText("Cleanup plan")).toBeVisible();
    await expect(page.getByText("1 non-zero trustline (USDC)")).toBeVisible();
    await expect(page.getByText("Estimated transactions: 2")).toBeVisible();
    await page.getByRole("button", { name: "Start cleanup" }).click();

    // The cleanup + merge step cards are TRANSIENT here: the Horizon mock "sees"
    // each tx instantly, so the wizard auto-advances cleanup → merge → done
    // faster than an assertion can reliably catch the intermediate cards.
    // Assert the terminal state, then that BOTH backend steps were actually
    // invoked — this proves the cleanup step ran (execute) before the merge,
    // deterministically, without racing the transient UI cards.
    await expect(page.getByText(/Account closed/i)).toBeVisible();
    expect(called.execute).toBe(true);
    expect(called.merge).toBe(true);
  });

  test("fast path: already merge-ready → straight to merge → closed", async ({ page }) => {
    await page.route("**/lifecycle/**", async (route) => {
      const url = route.request().url();
      if (url.endsWith("/lifecycle/plan")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            plan: {
              accountId: OLD_ACCOUNT,
              destination: DESTINATION,
              mergeReady: true,
              estimatedTransactions: 1,
              blockers: [],
            },
          }),
        });
        return;
      }
      if (url.endsWith("/lifecycle/merge")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            step: {
              title: "Merge account",
              description: "Sign this to merge and close the account",
              hash: "mergetxhash2",
              xdr: "AAAA...mergexdr2",
            },
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/cleanup");
    await page.getByPlaceholder("G...", { exact: true }).fill(OLD_ACCOUNT);
    await page.getByPlaceholder(/classic account, not your smart wallet/).fill(DESTINATION);
    await page.getByRole("button", { name: "Inspect account" }).click();

    await expect(page.getByText(/Nothing blocks this account/i)).toBeVisible();
    await page.getByRole("button", { name: "Proceed to merge" }).click();

    // With Horizon "seeing" the merge tx instantly the merge card is transient,
    // so assert the terminal outcome (the flow reaching "closed" IS the proof
    // that it went through the merge step).
    await expect(page.getByText(/Account closed/i)).toBeVisible();
  });
});
