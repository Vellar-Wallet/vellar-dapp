import { defineConfig } from "@playwright/test";

// Live-testnet e2e (idea.md §15 critical scenarios). Requires api-gateway
// (:4000) and wallet-service (:4001) running with relayer + Postgres config
// from .env; the web dev server is started/reused automatically.
//
// Postgres must actually be reachable (docker compose up, :5433 per .env), not
// just configured: the create-wallet spend budget is a Postgres ledger and the
// route fails CLOSED, so an unreachable database returns the same
// `503 create_budget_exceeded` / "Wallet-creation budget reached" as a real
// exhausted budget. Every live spec starts by creating a wallet, so they all
// fail at the same place with a message that points at the wrong cause.
//
// Run `pnpm exec playwright install chromium` once FROM THIS DIRECTORY
// (apps/web) — @playwright/test is a dependency here, not at the repo root,
// where `pnpm exec playwright` fails with "Command playwright not found".
// Then `pnpm test:e2e`.
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
