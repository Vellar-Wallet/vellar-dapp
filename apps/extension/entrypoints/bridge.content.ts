import { defineContentScript } from "#imports";
import { browser } from "wxt/browser";
import { handleBridgeMessageEvent } from "../lib/bridge-handler";

// Isolated-world bridge (technical-doc.md §8.2: approval logic is isolated
// from injected page context). Relays validated request envelopes from the
// page to the background worker and posts responses back. The page's origin
// is NEVER read from the message — the background derives it from the sender.
//
// Core message-handling logic lives in lib/bridge-handler.ts (testable in
// isolation; see #586); this file only wires it to the real window/runtime.

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  main() {
    window.addEventListener("message", (event) => {
      handleBridgeMessageEvent(
        { source: event.source, data: event.data },
        {
          pageWindow: window,
          sendRuntimeMessage: (message) => browser.runtime.sendMessage(message),
          postToPage: (data) => window.postMessage(data, "*"),
        },
      );
    });
  },
});
