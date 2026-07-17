import { defineContentScript } from "#imports";
import { browser } from "wxt/browser";
import { parseRequestEnvelope, responseEnvelope, errorPayload } from "@vela/provider-sdk";
import type { ProviderRequestMessage, ProviderRequestReply } from "../lib/messages";

// Isolated-world bridge (technical-doc.md §8.2: approval logic is isolated
// from injected page context). Relays validated request envelopes from the
// page to the background worker and posts responses back. The page's origin
// is NEVER read from the message — the background derives it from the sender.

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  main() {
    window.addEventListener("message", (event) => {
      if (event.source !== window) return; // same-window traffic only
      const envelope = parseRequestEnvelope(event.data);
      if (!envelope) return;

      const fail = (message: string) => {
        window.postMessage(responseEnvelope(envelope.id, errorPayload("internal", message)), "*");
      };

      // browser.runtime throws SYNCHRONOUSLY ("Extension context invalidated")
      // when the extension was reloaded/updated under a page still running
      // this old content script — degrade to an error response, never an
      // uncaught page error.
      try {
        const message: ProviderRequestMessage = { type: "provider-request", envelope };
        void browser.runtime
          .sendMessage(message)
          .then((payload: ProviderRequestReply) => {
            window.postMessage(responseEnvelope(envelope.id, payload), "*");
          })
          .catch(() => fail("The Vellar extension is unavailable"));
      } catch {
        fail("The Vellar extension was updated — reload this page and try again");
      }
    });
  },
});
