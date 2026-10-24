import { defineConfig } from "vitest/config";

// React component tests (.tsx) need a DOM; plain logic tests (lib/*.test.ts)
// stay on the lighter "node" environment. Split via test.projects rather than
// the deprecated environmentMatchGlobs, matching @vellar/ui's existing jsdom +
// @testing-library/react setup for the one place this package needs it (#588).
export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "lib",
          environment: "node",
          include: ["lib/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "components",
          environment: "jsdom",
          include: ["entrypoints/**/*.test.tsx"],
        },
      },
    ],
  },
});
