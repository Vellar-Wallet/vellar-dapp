import { expect, test } from "@playwright/test";
import { fundSmartWallet } from "./fund";

// The "deploy policy" critical scenario from idea.md §15, against LIVE testnet:
//   create wallet with passkey -> fund -> build a spending-limit policy ->
//   deploy the policy contract instance + passkey-sign kit.addPolicy to attach.
//
// Requires api-gateway (:4000), wallet-service (:4001) and policy-service
// (:4003) running with SPONSOR_SECRET_KEY set (policy instance deploys are
// sponsor-funded), plus the funded sponsor account and the uploaded policy
// wasm (docs/decisions.md 2026-07-17). The web dev server is auto-started.

test("passkey wallet: create, fund, deploy spending-limit policy (live testnet)", async ({
  page,
  context,
}) => {
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

  // --- Create wallet with passkey ---
  await page.goto("/app");
  await page.getByLabel(/wallet name/i).fill("e2e policy user");
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 120_000 });

  await page.getByRole("button", { name: "Receive" }).click();
  const addressLocator = page.locator("p.mono", { hasText: /^C[A-Z2-7]{55}$/ }).first();
  await expect(addressLocator).toBeVisible({ timeout: 30_000 });
  const contractId = (await addressLocator.textContent())!.trim();
  await page.getByRole("button", { name: "Close" }).click();

  // --- Fund the wallet (the account must exist on-chain to add a signer) ---
  await fundSmartWallet(contractId, 25n);
  await page.reload();
  await expect(page.locator(".bal")).toContainText("25", { timeout: 60_000 });

  // --- Build a spending-limit policy ---
  await page.goto("/policies");
  await page.getByText("Spending limit").click();
  await page.getByLabel(/daily limit/i).fill("10");
  await page.getByRole("button", { name: /validate & generate/i }).click();

  // Review shows the generated artifacts and the honestly-labelled cap.
  await expect(page.getByText(/policy generated/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/10 XLM/)).toBeVisible();

  // --- Deploy: instance deploy (sponsor) -> passkey-signed addPolicy attach ---
  await page.getByRole("button", { name: /deploy to my account/i }).click();

  // The whole chain lands on-chain: instance deploy + install + record.
  await expect(page.getByText(/policy attached to your account/i)).toBeVisible({
    timeout: 240_000,
  });
  // The attached policy contract id is shown (C…).
  await expect(page.locator("p.mono", { hasText: /^contract C[A-Z2-7]{55}$/ })).toBeVisible({
    timeout: 30_000,
  });
});
