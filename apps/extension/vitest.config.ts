import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// React component tests (.tsx) need a DOM; plain logic tests (lib/*.test.ts)
// stay on the lighter "node" environment. Split via test.projects rather than
// the deprecated environmentMatchGlobs, matching @vellar/ui's existing jsdom +
// @testing-library/react setup for the one place this package needs it (#588).
export default defineConfig({
  // WXT resolves `#imports` at build time; Vitest needs a real file to import
  // when a test pulls in an entrypoint (#775/#776 background tests).
  resolve: {
    alias: {
      "#imports": fileURLToPath(new URL("./test/imports-stub.ts", import.meta.url)),
    },
  },
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
          // Entrypoint tests live in test/ (WXT treats any root-level file in
          // entrypoints/ as a build entrypoint, so a sibling .test.tsx there
          // collides with background.ts). Keep the popup's existing in-place
          // test include too.
          include: ["entrypoints/**/*.test.tsx", "test/**/*.test.tsx"],
        },
      },
    ],
  },
});
