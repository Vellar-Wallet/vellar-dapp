import { defineConfig } from "vitest/config";

export default defineConfig({
  // Vite 8 transforms with oxc; the old `esbuild.jsx` key is ignored there.
  oxc: {
    jsx: { runtime: "automatic" },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.tsx", "src/**/*.test.ts"],
  },
});
