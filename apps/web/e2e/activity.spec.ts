import { expect, test } from "@playwright/test";
import { fundSmartWallet } from "./fund";

// Live-testnet e2e for the dashboard activity view (issue #403: "e2e for the
// dashboard view").
//
// The scenario is deliberately narrow: a smart wallet is created, funded with a
// real on-chain SAC transfer, and the dashboard must then show that transfer
// without an external explorer. The funding path is the same one wallet.spec.ts
// uses, so the row under test is a genuine contract event rather than a mock.

async function enableVirtualAuthenticator(
  context: import("@playwright/test").BrowserContext,
  page: import("@playwright/test").Page,
) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

test("dashboard activity shows a real on-chain transfer with its asset (live testnet)", async ({
  page,
  context,
}) => {
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));

  await enableVirtualAuthenticator(context, page);

  // --- Create a smart wallet (deploys the account via the relayer) ----------
  await page.goto("/app");
  await page.getByLabel(/wallet name/i).fill("activity e2e");
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 120_000 });

  await page.getByRole("button", { name: "Receive" }).click();
  const addressLocator = page.locator("p.mono", { hasText: /^C[A-Z2-7]{55}$/ }).first();
  await expect(addressLocator).toBeVisible({ timeout: 30_000 });
  const contractId = (await addressLocator.textContent())!.trim();
  await page.getByRole("button", { name: "Close" }).click();

  // --- Fund it, producing a real XLM SAC transfer event to this contract ----
  await fundSmartWallet(contractId, 25n);

  // --- The dashboard must show that transfer, with its asset ---------------
  const history = page.getByRole("list", { name: /transaction history/i });
  await expect(history).toBeVisible({ timeout: 90_000 });

  const incoming = history.getByRole("listitem").filter({ hasText: /Received/ }).first();
  await expect(incoming).toBeVisible({ timeout: 90_000 });

  // An amount is never rendered without the asset it is denominated in.
  await expect(incoming).toContainText(/XLM/);
  await expect(incoming).toContainText(/25/);
  await expect(incoming).toContainText(/success/i);

  // Each row links to a working explorer entry for the transaction hash.
  const href = await incoming.getAttribute("href");
  expect(href).toMatch(/^https:\/\/stellar\.expert\/explorer\/testnet\/tx\/[0-9a-f]{64}$/);

  // --- History survives a reload (it is re-derived from chain state) -------
  await page.reload();
  await expect(page.getByRole("list", { name: /transaction history/i })).toBeVisible({
    timeout: 90_000,
  });
  await expect(
    page.getByRole("list", { name: /transaction history/i }).getByRole("listitem").first(),
  ).toBeVisible({ timeout: 90_000 });

  // --- Rows never repeat --------------------------------------------------
  // "Load older" must walk backwards without re-serving a row: the L6 defect
  // class (a cursor that repeats or skips rows is worse than no pagination).
  const rowTexts = await history.getByRole("listitem").allInnerTexts();
  expect(new Set(rowTexts).size).toBe(rowTexts.length);

  // --- Pagination control is present once there is more than one page -------
  // With a single funding transfer the wallet has too little history to page,
  // so only assert the control is coherent in whichever state it renders.
  const loadOlder = page.getByRole("button", { name: /load older/i });
  const endOfHistory = page.getByText(/end of history/i);
  await expect(loadOlder.or(endOfHistory).first()).toBeVisible({ timeout: 30_000 });

  // If there is an older window, loading it must not repeat what is already
  // on screen — the invariant the live integration test pins, checked here
  // through the real panel.
  if (await loadOlder.isVisible().catch(() => false)) {
    const before = await history.getByRole("listitem").allInnerTexts();
    await loadOlder.click();
    await page.waitForTimeout(5_000);
    const after = await history.getByRole("listitem").allInnerTexts();
    expect(after.length).toBeGreaterThanOrEqual(before.length);
    // No row appears twice in the merged list.
    expect(new Set(after).size).toBe(after.length);
  }
});
