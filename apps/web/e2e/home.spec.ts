import { expect, test } from "@playwright/test";

test("home page renders @ci", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: /Your Stellar wallet/i })).toBeVisible();
});
