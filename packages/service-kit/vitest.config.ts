import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The boot tests spawn a real service entrypoint (tsx start-up), which exceeds the 5s
    // default on a loaded CI runner.
    testTimeout: 30_000,
  },
});
