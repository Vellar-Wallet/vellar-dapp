import { defineConfig } from "@playwright/test";

// Live-testnet e2e (idea.md §15 critical scenarios). Requires api-gateway
// (:4000) and wallet-service (:4001) running with relayer + Postgres config
// from .env; the web dev server is started/reused automatically.
// Run `pnpm exec playwright install chromium` once, then `pnpm test:e2e`.
export default defineConfig({
  testDir: "./e2e",
  timeout: 300_000,
  retries: 0,
  // Live-testnet specs share friendbot, the backend, and (for the extension
  // spec) OS-level popup focus — parallel workers interfere. Run serially.
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
