import { expect, test, type Page } from "@playwright/test";

// e2e: verify contract source (idea.md §15). Drives the real /verify UI with the
// gateway MOCKED (page.route), so it runs in CI with no backend/secrets. The
// real chain interaction (build → hash → compare deployed wasm) is covered by
// worker-service's pipeline.e2e + resolver tests + the live proof in
// docs/decisions.md; this spec proves the USER flow: submit source → poll status
// → see the trust badge, and the explorer path.

const CONTRACT = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";

/** Seed a connected session so AppShell doesn't redirect to /app. */
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
  }, CONTRACT);
}

// @ci — fully mocked (no backend/secrets), safe to run in CI.
test.describe("verify contract source (mocked gateway) @ci", () => {
  test.beforeEach(async ({ page }) => {
    await seedSession(page);
  });

  test("explorer: a verified contract shows the Verified badge + hashes", async ({ page }) => {
    await page.route("**/verification/**", async (route) => {
      const url = route.request().url();
      if (url.endsWith(`/verification/${CONTRACT}`)) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            contractId: CONTRACT,
            records: [
              {
                id: "rec-1",
                contractId: CONTRACT,
                sourceType: "repo",
                repoUrl: "https://github.com/example/contract",
                commitHash: "a1b2c3d",
                toolchainVersion: "1.94.0",
                outputHash: "0f6b858d".padEnd(64, "0"),
                deployedHash: "0f6b858d".padEnd(64, "0"),
                status: "verified",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/verify");
    await page.getByLabel("Contract address").fill(CONTRACT);
    await page.getByRole("button", { name: "Check" }).click();

    // The trust badge renders "Verified source".
    await expect(page.getByText("Verified source").first()).toBeVisible();
    await expect(page.getByText("1.94.0")).toBeVisible();
    await expect(page.getByText("1 verification attempt")).toBeVisible();
  });

  test("explorer: an unknown contract shows Unverified", async ({ page }) => {
    await page.route("**/verification/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ contractId: CONTRACT, records: [] }),
      });
    });

    await page.goto("/verify");
    await page.getByLabel("Contract address").fill(CONTRACT);
    await page.getByRole("button", { name: "Check" }).click();

    await expect(page.getByText("Unverified")).toBeVisible();
    await expect(page.getByText(/No verification has been submitted/i)).toBeVisible();
  });

  test("submit: a repo submission is accepted and confirmed", async ({ page }) => {
    let submittedBody: unknown;
    await page.route("**/verification/submit", async (route) => {
      submittedBody = route.request().postDataJSON();
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          record: { id: "rec-2", contractId: CONTRACT, status: "submitted" },
        }),
      });
    });

    await page.goto("/verify");
    await page.getByRole("tab", { name: "Submit for verification" }).click();

    await page.getByLabel("Contract address").fill(CONTRACT);
    await page.getByLabel("Repository URL").fill("https://github.com/example/contract");
    await page.getByLabel("Commit hash").fill("a1b2c3d");
    await page.getByLabel("Toolchain version").fill("1.94.0");
    await page.getByLabel(/Build flags/i).fill("--release");

    await page.getByRole("button", { name: "Submit for verification" }).click();

    await expect(page.getByText("Submission received")).toBeVisible();
    expect(submittedBody).toMatchObject({
      contractId: CONTRACT,
      sourceType: "repo",
      repoUrl: "https://github.com/example/contract",
      commitHash: "a1b2c3d",
      toolchainVersion: "1.94.0",
      buildFlags: ["--release"],
    });
  });
});
