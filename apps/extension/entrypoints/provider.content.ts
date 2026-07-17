import { defineContentScript } from "#imports";
import { createPageProvider, createWindowTransport } from "@vela/provider-sdk";

// MAIN-world script: exposes the wallet provider to dApps as window.vela
// (technical-doc.md §5.3). Runs in page context — it holds no state and no
// privileges; everything round-trips through the isolated bridge + background.

declare global {
  interface Window {
    vela?: unknown;
  }
}

export default defineContentScript({
  matches: ["<all_urls>"],
  world: "MAIN",
  runAt: "document_start",
  main() {
    if (window.vela) return; // never clobber an existing provider
    window.vela = createPageProvider({ transport: createWindowTransport(window) });
  },
});
