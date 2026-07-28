import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  // Explicit imports only: the auto-import scanner injects wxt/utils/storage
  // into workspace packages that merely use "storage" as an identifier.
  imports: false,
  manifest: {
    name: "Vellar Wallet",
    description: "Stellar smart wallet companion: dApp connections and fast transaction signing.",
    permissions: ["storage"],
    icons: {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png",
    },
  },
});
