import { parseRequestEnvelope, responseEnvelope, errorPayload } from "@vellar/provider-sdk";
import type { ProviderRequestMessage, ProviderRequestReply } from "./messages";

/**
 * Pure, injectable core of the isolated-world bridge content script (#586).
 * Extracted from entrypoints/bridge.content.ts so it is testable: WXT content
 * scripts register a live `window.addEventListener` inside `main()`, which
 * this repo's vitest config (environment: "node", include: "lib/**\/*.test.ts")
 * cannot exercise directly.
 *
 * Security property this handler relies on, and that the tests below verify:
 * the ONLY path that can resolve a page's pending request is
 * `sendRuntimeMessage(...)`'s own resolved/rejected promise — a channel
 * exposed only to isolated-world content scripts, never to MAIN-world or
 * page JS. The handler never treats an inbound `window.postMessage` as a
 * response; it only ever parses inbound messages as requests
 * (`parseRequestEnvelope`). A malicious page script forging a message
 * shaped like a background response (even one reusing a legitimate
 * request's id) is therefore never interpreted as a reply: it either fails
 * `parseRequestEnvelope`'s `kind: "request"` discriminant entirely (if it
 * sets `kind: "response"`, matching what a forger would plausibly try), or,
 * if it coincidentally also validates as a well-formed new request, it is
 * processed as a brand-new, independent request (routed through the real
 * background and shown to the real approval UI) rather than silently
 * resolving the attacker's forged payload into the page's pending call.
 */
export interface BridgeMessageEvent {
  /** `window.MessageEvent.source`: must equal the page's own `window` to be in-window traffic. */
  source: unknown;
  /** `window.MessageEvent.data`: untrusted, attacker-controllable when `source` matches. */
  data: unknown;
}

export interface BridgeHandlerOptions {
  /** The page's own `window` object, to compare `event.source` against. */
  pageWindow: unknown;
  /** Isolated-world-only channel to the background; unreachable from page JS. */
  sendRuntimeMessage: (message: ProviderRequestMessage) => Promise<ProviderRequestReply>;
  /** Posts a message back into the page (`window.postMessage` in production). */
  postToPage: (data: unknown) => void;
}

/**
 * Handles one inbound `window` "message" event for the bridge content script.
 * Call this from a real `window.addEventListener("message", ...)` listener
 * in production; call it directly with a synthetic event in tests.
 */
export function handleBridgeMessageEvent(
  event: BridgeMessageEvent,
  options: BridgeHandlerOptions,
): void {
  if (event.source !== options.pageWindow) return; // same-window traffic only

  const envelope = parseRequestEnvelope(event.data);
  if (!envelope) return;

  const fail = (message: string) => {
    options.postToPage(responseEnvelope(envelope.id, errorPayload("internal", message)));
  };

  // browser.runtime throws SYNCHRONOUSLY ("Extension context invalidated")
  // when the extension was reloaded/updated under a page still running this
  // old content script — degrade to an error response, never an uncaught
  // page error.
  try {
    const message: ProviderRequestMessage = { type: "provider-request", envelope };
    void options
      .sendRuntimeMessage(message)
      .then((payload: ProviderRequestReply) => {
        options.postToPage(responseEnvelope(envelope.id, payload));
      })
      .catch(() => fail("The Vellar extension is unavailable"));
  } catch {
    fail("The Vellar extension was updated — reload this page and try again");
  }
}
