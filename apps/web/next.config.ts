import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship raw TypeScript (exports point at src/), so Next
  // must transpile them. passkey-kit and its SDK deps also ship raw TS.
  transpilePackages: [
    "passkey-kit",
    "passkey-kit-sdk",
    "sac-sdk",
    "@vela/types",
    "@vela/ui",
    "@vela/wallet-sdk",
    "@vela/passkey",
    "@vela/provider-sdk",
    "@vela/policy-sdk",
    "@vela/verification-sdk",
    "@vela/lifecycle-sdk",
  ],
};

export default nextConfig;
