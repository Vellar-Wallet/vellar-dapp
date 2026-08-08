import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    server: {
      deps: {
        // passkey-kit and its SDK deps ship raw TypeScript; Vitest must
        // transform them (Node's loader refuses to type-strip node_modules).
        // Mirrors apps/web's next.config transpilePackages.
        inline: ["passkey-kit", "passkey-kit-sdk", "sac-sdk"],
      },
    },
  },
});
