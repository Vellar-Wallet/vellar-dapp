import { defineContentScript } from "wxt/utils/define-content-script";
import { browser } from "wxt/browser";
import {
  PROVIDER_CHANNEL,
  parseRequestEnvelope,
  parseResponseEnvelope,
  responseEnvelope,
  errorPayload,
  type ResponsePayload,
} from "@vellar/provider-sdk";
import type { ProviderRequestMessage, ProviderRequestReply } from "../lib/messages";

// Isolated-world bridge (technical-doc.md §8.2: approval logic is isolated
// from injected page context). Relays validated request envelopes from the
// page to the background worker and posts responses back. The page's origin
// is NEVER read from the message — the background derives it from the sender.

export interface BridgeWindow {
  postMessage(message: unknown, targetOrigin: string): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
    options?: boolean | EventListenerOptions,
  ): void;
}

export type BridgeSendMessage = (message: ProviderRequestMessage) => Promise<ProviderRequestReply>;

function isProtocolResponseCandidate(data: unknown): boolean {
  if (parseResponseEnvelope(data) !== undefined) return true;
  if (typeof data !== "object" || data === null) return false;
  const rec = data as Record<string, unknown>;
  return rec.channel === PROVIDER_CHANNEL && rec.kind === "response";
}

/**
 * Attaches the isolated-world message bridge to `win`.
 *
 * Registers in the capture phase (`useCapture = true`) at `document_start` so
 * it inspects every `window` message event before bubble-phase listeners
 * (including `createWindowTransport` in the main-world provider script). Any
 * response envelope not emitted by this bridge after a background-worker
 * reply is halted via `stopImmediatePropagation()`, preventing page scripts
 * from spoofing responses for in-flight request IDs.
 */
export function attachBridge(
  win: BridgeWindow,
  sendMessage: BridgeSendMessage = (message) => browser.runtime.sendMessage(message),
): () => void {
  const postMessage = win.postMessage.bind(win);
  const inFlightRequests = new Set<string>();
  const authorizedResponses = new WeakSet<object>();
  const authorizedSignatures = new Map<string, string[]>();

  const emitResponse = (id: string, payload: ResponsePayload) => {
    const out = responseEnvelope(id, payload);
    authorizedResponses.add(out);
    const list = authorizedSignatures.get(id) ?? [];
    list.push(JSON.stringify(out));
    authorizedSignatures.set(id, list);
    postMessage(out, "*");
  };

  const consumeAuthorizedResponse = (data: unknown): boolean => {
    const parsed = parseResponseEnvelope(data);
    if (!parsed) return false;
    if (inFlightRequests.has(parsed.id)) return false;

    const queue = authorizedSignatures.get(parsed.id);
    const serialized = JSON.stringify(parsed);
    const queueIdx = queue ? queue.indexOf(serialized) : -1;
    const hasObjectRef = typeof data === "object" && data !== null && authorizedResponses.has(data);

    if (!hasObjectRef && queueIdx === -1) {
      return false;
    }

    if (typeof data === "object" && data !== null) {
      authorizedResponses.delete(data);
    }
    if (queue && queueIdx !== -1) {
      queue.splice(queueIdx, 1);
      if (queue.length === 0) {
        authorizedSignatures.delete(parsed.id);
      }
    }
    return true;
  };

  const onMessage = (event: MessageEvent) => {
    if (isProtocolResponseCandidate(event.data)) {
      if (event.source !== win || !consumeAuthorizedResponse(event.data)) {
        event.stopImmediatePropagation?.();
        event.stopPropagation?.();
      }
      return;
    }

    if (event.source !== win) return; // same-window traffic only
    const envelope = parseRequestEnvelope(event.data);
    if (!envelope) return;
    if (inFlightRequests.has(envelope.id)) return;

    inFlightRequests.add(envelope.id);

    const fail = (message: string) => {
      inFlightRequests.delete(envelope.id);
      emitResponse(envelope.id, errorPayload("internal", message));
    };

    // browser.runtime throws SYNCHRONOUSLY ("Extension context invalidated")
    // when the extension was reloaded/updated under a page still running
    // this old content script — degrade to an error response, never an
    // uncaught page error.
    try {
      const message: ProviderRequestMessage = { type: "provider-request", envelope };
      void sendMessage(message)
        .then((payload: ProviderRequestReply) => {
          inFlightRequests.delete(envelope.id);
          emitResponse(envelope.id, payload);
        })
        .catch(() => fail("The Vellar extension is unavailable"));
    } catch {
      fail("The Vellar extension was updated — reload this page and try again");
    }
  };

  win.addEventListener("message", onMessage, true);
  return () => win.removeEventListener("message", onMessage, true);
}

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  main() {
    attachBridge(window);
  },
});
