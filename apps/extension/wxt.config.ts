import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  // Explicit imports only: the auto-import scanner injects wxt/utils/storage
  // into workspace packages that merely use "storage" as an identifier.
  imports: false,
  manifest: {
    name: "VELA Wallet",
    description: "Stellar smart wallet companion: dApp connections and fast transaction signing.",
    permissions: ["storage"],
  },
});
