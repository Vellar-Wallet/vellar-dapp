import { expect, test } from "@playwright/test";
import { fundSmartWallet } from "./fund";

// The critical e2e scenarios from idea.md §15, against LIVE testnet with a
// virtual platform authenticator standing in for Touch ID:
//   create wallet with passkey -> fund -> sign and submit payment -> reconnect.
//
// idea.md itself is not present anywhere in this repository as of writing —
// referenced here only because these existing spec files already cite it by
// section number; §15's exact wording could not be independently verified.

async function enableVirtualAuthenticator(context: import("@playwright/test").BrowserContext, page: import("@playwright/test").Page) {
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

test("passkey wallet: create, fund, pay, reconnect (live testnet)", async ({ page, context }) => {
  // Browser-side failures are the most valuable diagnostic in live e2e runs.
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("[browser]", msg.text());
  });
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));

  await enableVirtualAuthenticator(context, page);

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

// #321: reconnect after session expiry, with a data-loss check the existing
// "create, fund, pay, reconnect" scenario above does not make (it only
// re-checks the contract id).
//
// IMPORTANT SCOPE NOTE, disclosed rather than silently assumed: this repo
// has no client-side session-expiry DETECTION today — `WalletSession` (see
// `@vellar/types`) carries no `expiresAt`, `wallet-context.tsx` never checks
// for a 401 and never auto-prompts a reconnect, and the server-side 7-day
// sliding-window expiry (`wallet-service/src/server.ts`'s
// `SESSION_TTL_MS`/`resolveSessionCapability`) is only exercised by that
// service's own unit tests (`server.test.ts`'s "an EXPIRED session bearer is
// treated as ABSENT" case), never surfaced to the UI. There is therefore no
// UI behavior today that specifically distinguishes "your session expired,
// please sign in again" from a manual disconnect — both currently look
// identical to a user: the app has no persisted session, and the ONLY path
// back in either case is the same manual "Sign in" flow the scenario above
// already exercises.
//
// What THIS test adds on top of that: it treats the manual reconnect
// trigger as standing in for an expired session (the only trigger the app
// actually implements), and — unlike the existing scenario — verifies the
// "regains access without data loss" half of #321's acceptance criteria
// concretely: the balance carries over, and a genuinely NEW server-side
// session is established (visible as a fresh "This device" entry in
// Settings), not a reused/rehydrated stale one.
test("reconnect after a lost session regains access with no data loss (live testnet)", async ({
  page,
  context,
}) => {
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("[browser]", msg.text());
  });
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));

  await enableVirtualAuthenticator(context, page);

  // --- Create and fund a wallet ---
  await page.goto("/app");
  await page.getByLabel(/wallet name/i).fill("e2e reconnect user");
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 120_000 });

  await page.getByRole("button", { name: "Receive" }).click();
  const addressLocator = page.locator("p.mono", { hasText: /^C[A-Z2-7]{55}$/ }).first();
  await expect(addressLocator).toBeVisible({ timeout: 30_000 });
  const contractId = (await addressLocator.textContent())!.trim();
  await page.getByRole("button", { name: "Close" }).click();

  const balanceHero = page.locator(".bal");
  const funder = await fundSmartWallet(contractId, 10n);
  await page.reload();
  await expect(balanceHero).toContainText("10", { timeout: 60_000 });
  void funder; // funded for balance state only; no payment needed in this scenario

  // Record the ORIGINAL session before it's lost, via Settings' session list
  // (the same page reconnect verification checks afterward) — "This device"
  // marks whichever session the currently-loaded page is using.
  await page.goto("/settings");
  const sessionEntries = page.locator("li", { hasText: "This device" });
  await expect(sessionEntries).toHaveCount(1, { timeout: 30_000 });
  const originalSessionText = await sessionEntries.first().textContent();

  // --- Lose the session (standing in for expiry — see the scope note above) ---
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("button", { name: "Create wallet" })).toBeVisible({
    timeout: 30_000,
  });

  // --- Reconnect with the same passkey ---
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 60_000 });

  // No data loss: same account, same balance — nothing was reset or re-created.
  await page.getByRole("button", { name: "Receive" }).click();
  await expect(page.locator("p.mono", { hasText: contractId })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Close" }).click();
  await expect(balanceHero).toContainText("10", { timeout: 60_000 });

  // Access is via a genuinely NEW session, not a stale rehydrated one: the
  // old session's audit/session record is gone from "current", and a fresh
  // one has taken its place. (The revoked/former session may still be
  // listed as a past — non-"This device" — entry; this only asserts the
  // CURRENT one changed, matching what a user could actually observe.)
  await page.goto("/settings");
  await expect(sessionEntries).toHaveCount(1, { timeout: 30_000 });
  const newSessionText = await sessionEntries.first().textContent();
  expect(newSessionText).not.toBe(originalSessionText);
});
