import { expect, test } from "@playwright/test";
import { fundSmartWallet } from "./fund";

// The critical e2e scenarios from idea.md §15, against LIVE testnet with a
// virtual platform authenticator standing in for Touch ID:
//   create wallet with passkey -> fund -> sign and submit payment -> reconnect.

test("passkey wallet: create, fund, pay, reconnect (live testnet)", async ({ page, context }) => {
  // Browser-side failures are the most valuable diagnostic in live e2e runs.
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("[browser]", msg.text());
  });
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));

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

  // --- Create wallet with passkey (deploys the smart account via relayer) ---
  await page.goto("/app");
  await page.getByLabel(/wallet name/i).fill("e2e user");
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 120_000 });

  // Read the full contract id from the Receive panel.
  await page.getByRole("button", { name: "Receive" }).click();
  const addressLocator = page.locator("p.mono", { hasText: /^C[A-Z2-7]{55}$/ }).first();
  await expect(addressLocator).toBeVisible({ timeout: 30_000 });
  const contractId = (await addressLocator.textContent())!.trim();
  await page.getByRole("button", { name: "Close" }).click();

  // Fresh wallet: balance hero reads 0 XLM.
  const balanceHero = page.locator(".bal");
  await expect(balanceHero).toContainText("0", { timeout: 60_000 });

  // --- Fund the smart wallet on-chain, then confirm the dashboard sees it ---
  const funder = await fundSmartWallet(contractId, 25n);
  await page.reload();
  await expect(balanceHero).toContainText("25", { timeout: 60_000 });

  // --- Sign and submit a payment with the passkey ---
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByLabel(/recipient/i).fill(funder.publicKey());
  await page.getByLabel(/amount/i).fill("1.5");
  await page.getByRole("button", { name: /review payment/i }).click();

  const review = page.getByRole("dialog", { name: /review payment/i });
  await expect(review).toBeVisible({ timeout: 60_000 });
  await expect(review.getByText("1.5 XLM")).toBeVisible();
  await expect(review.getByText(funder.publicKey())).toBeVisible();

  await page.getByRole("button", { name: /confirm with passkey/i }).click();
  await expect(page.getByText(/payment confirmed/i)).toBeVisible({ timeout: 180_000 });

  // --- Reconnect with the same passkey ---
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("button", { name: "Create wallet" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 60_000 });
  await page.getByRole("button", { name: "Receive" }).click();
  await expect(page.locator("p.mono", { hasText: contractId })).toBeVisible({ timeout: 30_000 });
});
