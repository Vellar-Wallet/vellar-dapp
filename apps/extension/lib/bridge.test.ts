import { describe, expect, it, vi } from "vitest";
import {
  createPageProvider,
  createWindowTransport,
  errorPayload,
  parseRequestEnvelope,
  ProviderError,
  responseEnvelope,
  type ResponsePayload,
} from "@vellar/provider-sdk";
import type { ProviderRequestMessage, ProviderRequestReply } from "./messages";

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      sendMessage: vi.fn(),
    },
  },
}));

import { attachBridge, type BridgeWindow } from "../entrypoints/bridge.content";

interface RegisteredListener {
  listener: (event: MessageEvent) => void;
  capture: boolean;
}

/**
 * Spec-accurate window message bus modeling capture-phase (`true`) followed by
 * bubble-phase (`false`) listener dispatch and `stopImmediatePropagation()`.
 */
function createFakeWindow(options?: { structuredCloneMessages?: boolean }) {
  const listeners: RegisteredListener[] = [];
  const cloneIfNeeded = <T>(val: T): T =>
    options?.structuredCloneMessages ? (JSON.parse(JSON.stringify(val)) as T) : val;

  function isCapture(opts?: boolean | EventListenerOptions): boolean {
    if (typeof opts === "boolean") return opts;
    return Boolean(opts?.capture);
  }

  const win: BridgeWindow & {
    dispatchFromSource(data: unknown, source: unknown): { stopped: boolean };
  } = {
    postMessage(message: unknown, _targetOrigin: string) {
      win.dispatchFromSource(cloneIfNeeded(message), win);
    },
    dispatchFromSource(data: unknown, source: unknown) {
      let immediateStopped = false;
      let propagationStopped = false;
      const event = {
        data,
        source,
        stopImmediatePropagation() {
          immediateStopped = true;
          propagationStopped = true;
        },
        stopPropagation() {
          propagationStopped = true;
        },
      } as unknown as MessageEvent;

      const snapshot = [...listeners];
      for (const entry of snapshot.filter((l) => l.capture)) {
        entry.listener(event);
        if (immediateStopped) break;
      }
      if (!immediateStopped) {
        for (const entry of snapshot.filter((l) => !l.capture)) {
          entry.listener(event);
          if (immediateStopped) break;
        }
      }
      return { stopped: immediateStopped || propagationStopped };
    },
    addEventListener(_type: "message", listener: (event: MessageEvent) => void, opts) {
      listeners.push({ listener, capture: isCapture(opts) });
    },
    removeEventListener(_type: "message", listener: (event: MessageEvent) => void, opts) {
      const cap = isCapture(opts);
      const idx = listeners.findIndex((l) => l.listener === listener && l.capture === cap);
      if (idx !== -1) listeners.splice(idx, 1);
    },
  };

  return win;
}

describe("bridge.content spoofing protection", () => {
  it("blocks a malicious page script from spoofing a response for an in-flight request ID", async () => {
    const win = createFakeWindow();
    let pendingBgRequest:
      | {
          id: string;
          resolve: (reply: ProviderRequestReply) => void;
        }
      | undefined;

    const sendMessage = vi.fn(
      (msg: ProviderRequestMessage) =>
        new Promise<ProviderRequestReply>((resolve) => {
          pendingBgRequest = { id: msg.envelope.id, resolve };
        }),
    );

    // 1. Bridge attaches at document_start in capture phase.
    attachBridge(win, sendMessage);

    // 2. Main-world provider attaches via createWindowTransport.
    const transport = createWindowTransport(win as unknown as Window);
    const provider = createPageProvider({ transport });

    // 3. A malicious third-party script on the page snoops outbound requests on window
    // and immediately posts a forged response matching the in-flight request ID.
    let spoofAttemptedForId: string | undefined;
    win.addEventListener("message", (event) => {
      const req = parseRequestEnvelope(event.data);
      if (!req) return;
      spoofAttemptedForId = req.id;
      win.postMessage(
        responseEnvelope(req.id, {
          method: "connect",
          result: { address: "CMALICIOUS_SPOOFED_WALLET", network: "testnet" },
        }),
        "*",
      );
    });

    let settledResult: { address: string; network: string } | undefined;
    const connectPromise = provider.connect("testnet").then((res) => {
      settledResult = res;
      return res;
    });

    // The page script saw the request ID and posted its forged response,
    // but the provider MUST NOT have resolved with the spoofed payload.
    expect(spoofAttemptedForId).toBeDefined();
    expect(spoofAttemptedForId).toBe(pendingBgRequest?.id);
    await Promise.resolve();
    expect(settledResult).toBeUndefined();

    // 4. Now the extension background worker replies with the authentic wallet address.
    pendingBgRequest!.resolve({
      method: "connect",
      result: { address: "CREAL_EXTENSION_WALLET", network: "testnet" },
    });

    await expect(connectPromise).resolves.toEqual({
      address: "CREAL_EXTENSION_WALLET",
      network: "testnet",
    });
  });

  it("prevents a page script from spoofing a rejection or fake signedXdr while signTransaction is pending", async () => {
    const win = createFakeWindow({ structuredCloneMessages: true });
    let resolveBg!: (reply: ProviderRequestReply) => void;
    let capturedId!: string;

    attachBridge(
      win,
      (msg) =>
        new Promise<ProviderRequestReply>((resolve) => {
          capturedId = msg.envelope.id;
          resolveBg = resolve;
        }),
    );

    const provider = createPageProvider({
      transport: createWindowTransport(win as unknown as Window),
    });

    const signPromise = provider.signTransaction({
      xdr: "AAAA_UNSIGNED_XDR",
      network: "testnet",
    });

    // Malicious script tries both a forged rejection and a forged signedXdr while in-flight.
    win.postMessage(
      responseEnvelope(capturedId, errorPayload("rejected", "Spoofed rejection")),
      "*",
    );
    win.postMessage(
      responseEnvelope(capturedId, {
        method: "sign_transaction",
        result: { signedXdr: "FORGED_XDR_FROM_PAGE_SCRIPT" },
      }),
      "*",
    );

    // Now the real extension background worker resolves.
    resolveBg({
      method: "sign_transaction",
      result: { signedXdr: "AUTHENTIC_EXTENSION_SIGNED_XDR" },
    });

    await expect(signPromise).resolves.toEqual({
      signedXdr: "AUTHENTIC_EXTENSION_SIGNED_XDR",
    });
  });

  it("blocks cross-frame response envelopes even if they come from a non-window source", () => {
    const win = createFakeWindow();
    attachBridge(win, async () => ({
      method: "disconnect",
      result: {},
    }));

    const receivedByBubbleListener: unknown[] = [];
    win.addEventListener("message", (event) => {
      receivedByBubbleListener.push(event.data);
    });

    const foreignFrame = {};
    const spoofed = responseEnvelope("req-99", {
      method: "connect",
      result: { address: "CFOREIGN_FRAME", network: "testnet" },
    });

    const { stopped } = win.dispatchFromSource(spoofed, foreignFrame);
    expect(stopped).toBe(true);
    expect(receivedByBubbleListener).toHaveLength(0);
  });

  it("consumes extension response authorization once so a captured response cannot be replayed", async () => {
    const win = createFakeWindow();
    attachBridge(win, async (): Promise<ResponsePayload> => ({
      method: "connect",
      result: { address: "CREAL", network: "testnet" },
    }));

    const provider = createPageProvider({
      transport: createWindowTransport(win as unknown as Window),
    });

    const seenResponses: unknown[] = [];
    win.addEventListener("message", (event) => {
      if ((event.data as { kind?: string } | null)?.kind === "response") {
        seenResponses.push(event.data);
      }
    });

    await expect(provider.connect("testnet")).resolves.toEqual({
      address: "CREAL",
      network: "testnet",
    });
    expect(seenResponses).toHaveLength(1);

    // Re-posting the exact same response object a second time must be blocked.
    win.postMessage(seenResponses[0], "*");
    expect(seenResponses).toHaveLength(1);
  });

  it("still delivers legitimate internal error responses when runtime.sendMessage rejects or throws", async () => {
    const win = createFakeWindow();
    let shouldThrowSynchronously = true;

    attachBridge(win, () => {
      if (shouldThrowSynchronously) {
        throw new Error("Extension context invalidated");
      }
      return Promise.reject(new Error("Background worker disconnected"));
    });

    const provider = createPageProvider({
      transport: createWindowTransport(win as unknown as Window),
    });

    await expect(provider.connect("testnet")).rejects.toThrow(ProviderError);
    await expect(provider.connect("testnet")).rejects.toMatchObject({
      code: "internal",
      message: "The Vellar extension was updated — reload this page and try again",
    });

    shouldThrowSynchronously = false;
    await expect(provider.connect("testnet")).rejects.toMatchObject({
      code: "internal",
      message: "The Vellar extension is unavailable",
    });
  });
});
