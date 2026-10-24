import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The boot test spawns tsx as a real child process and waits for it to
    // exit; give it more headroom than the default 5s.
    testTimeout: 20_000,
  },
});
