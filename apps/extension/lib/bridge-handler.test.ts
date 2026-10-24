/**
 * Tests for the isolated-world bridge's message handler (#586).
 *
 * The real spoofing concern: can a page script post a message that the
 * bridge mistakes for a genuine response from the extension background,
 * bypassing the real browser.runtime.sendMessage relay? These tests
 * confirm it cannot, because the handler never parses an inbound
 * window message as a response at all — only ever as a request
 * (parseRequestEnvelope's `kind: "request"` discriminant) — and the only
 * path that can post a real response is the handler's own call into
 * sendRuntimeMessage, a channel unreachable from page JS.
 *
 * Covers:
 *  - happy path: a well-formed request is relayed to the background and the
 *    real resolved payload is posted back
 *  - a forged message shaped like a background response (kind: "response")
 *    is silently ignored, never treated as a reply
 *  - a forged response-shaped message that reuses a real pending request's
 *    id is still ignored, not substituted for the real reply
 *  - non-window-sourced messages (iframe etc.) are ignored entirely
 *  - a synchronous "Extension context invalidated" throw from sendMessage
 *    degrades to an error response instead of propagating
 */
import { describe, expect, it, vi } from "vitest";
import { requestEnvelope, errorPayload } from "@vellar/provider-sdk";
import { handleBridgeMessageEvent, type BridgeHandlerOptions } from "./bridge-handler";

const PAGE_WINDOW = { marker: "the-real-window" };

function makeOptions(
  overrides: Partial<BridgeHandlerOptions> = {},
): BridgeHandlerOptions & { postedMessages: unknown[] } {
  const postedMessages: unknown[] = [];
  return {
    pageWindow: PAGE_WINDOW,
    sendRuntimeMessage: vi.fn(),
    postToPage: (data) => postedMessages.push(data),
    postedMessages,
    ...overrides,
  };
}

describe("handleBridgeMessageEvent", () => {
  it("relays a well-formed request to the background and posts the real resolved reply (happy path)", async () => {
    const envelope = requestEnvelope("req-1", {
      method: "connect",
      params: { network: "testnet" },
    });
    const reply = {
      method: "connect" as const,
      result: { address: "GABC...", network: "testnet" },
    };
    const sendRuntimeMessage = vi.fn().mockResolvedValue(reply);
    const options = makeOptions({ sendRuntimeMessage });

    handleBridgeMessageEvent({ source: PAGE_WINDOW, data: envelope }, options);
    await vi.waitFor(() => expect(options.postedMessages).toHaveLength(1));

    // parseRequestEnvelope fills in the default `version` field during
    // validation, so the relayed envelope is the re-validated copy, not the
    // literal object constructed above.
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      type: "provider-request",
      envelope: { ...envelope, version: 1 },
    });
    expect(options.postedMessages[0]).toMatchObject({
      channel: "vela-provider",
      kind: "response",
      id: "req-1",
      payload: reply,
    });
  });

  it("ignores a forged message shaped like a background response, never treating it as a reply", async () => {
    const sendRuntimeMessage = vi.fn();
    const options = makeOptions({ sendRuntimeMessage });

    // An attacker page script posting exactly what a real background reply
    // would look like, with no corresponding real request ever sent.
    const forgedResponse = {
      channel: "vela-provider",
      kind: "response",
      id: "forged-1",
      payload: { method: "sign_transaction", result: { signedXdr: "attacker-controlled" } },
    };

    handleBridgeMessageEvent({ source: PAGE_WINDOW, data: forgedResponse }, options);
    // Give any accidental async path a chance to run before asserting nothing happened.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendRuntimeMessage).not.toHaveBeenCalled();
    expect(options.postedMessages).toHaveLength(0);
  });

  it("ignores a forged response-shaped message that reuses a real pending request's id, instead of substituting it for the real reply", async () => {
    const realEnvelope = requestEnvelope("shared-id", {
      method: "sign_transaction",
      params: { xdr: "AAAA", network: "testnet" },
    });
    const realReply = {
      method: "sign_transaction" as const,
      result: { signedXdr: "real-signed-xdr" },
    };
    const sendRuntimeMessage = vi.fn().mockResolvedValue(realReply);
    const options = makeOptions({ sendRuntimeMessage });

    // The forged message arrives first, reusing the id the real request will
    // use. It must not be mistaken for (or interfere with) the real reply.
    const forgedResponse = {
      channel: "vela-provider",
      kind: "response",
      id: "shared-id",
      payload: { method: "sign_transaction", result: { signedXdr: "attacker-controlled" } },
    };
    handleBridgeMessageEvent({ source: PAGE_WINDOW, data: forgedResponse }, options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(options.postedMessages).toHaveLength(0);

    // The real request is then sent and relayed normally.
    handleBridgeMessageEvent({ source: PAGE_WINDOW, data: realEnvelope }, options);
    await vi.waitFor(() => expect(options.postedMessages).toHaveLength(1));

    expect(options.postedMessages[0]).toMatchObject({
      id: "shared-id",
      payload: realReply,
    });
  });

  it("ignores a message whose source is not the page's own window (e.g. a nested iframe)", async () => {
    const envelope = requestEnvelope("req-2", {
      method: "connect",
      params: { network: "testnet" },
    });
    const sendRuntimeMessage = vi.fn();
    const options = makeOptions({ sendRuntimeMessage });

    handleBridgeMessageEvent({ source: { marker: "an-iframe" }, data: envelope }, options);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendRuntimeMessage).not.toHaveBeenCalled();
    expect(options.postedMessages).toHaveLength(0);
  });

  it("ignores malformed data that doesn't parse as a request envelope at all", async () => {
    const sendRuntimeMessage = vi.fn();
    const options = makeOptions({ sendRuntimeMessage });

    handleBridgeMessageEvent({ source: PAGE_WINDOW, data: { nonsense: true } }, options);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendRuntimeMessage).not.toHaveBeenCalled();
    expect(options.postedMessages).toHaveLength(0);
  });

  it("degrades a synchronous 'Extension context invalidated' throw to an error response", async () => {
    const envelope = requestEnvelope("req-3", {
      method: "connect",
      params: { network: "testnet" },
    });
    const sendRuntimeMessage = vi.fn(() => {
      throw new Error("Extension context invalidated.");
    });
    const options = makeOptions({ sendRuntimeMessage });

    expect(() =>
      handleBridgeMessageEvent({ source: PAGE_WINDOW, data: envelope }, options),
    ).not.toThrow();

    expect(options.postedMessages).toHaveLength(1);
    expect(options.postedMessages[0]).toMatchObject({
      id: "req-3",
      payload: errorPayload(
        "internal",
        "The Vellar extension was updated — reload this page and try again",
      ),
    });
  });

  it("degrades a rejected sendRuntimeMessage promise to an error response", async () => {
    const envelope = requestEnvelope("req-4", {
      method: "connect",
      params: { network: "testnet" },
    });
    const sendRuntimeMessage = vi.fn().mockRejectedValue(new Error("disconnected"));
    const options = makeOptions({ sendRuntimeMessage });

    handleBridgeMessageEvent({ source: PAGE_WINDOW, data: envelope }, options);
    await vi.waitFor(() => expect(options.postedMessages).toHaveLength(1));

    expect(options.postedMessages[0]).toMatchObject({
      id: "req-4",
      payload: errorPayload("internal", "The Vellar extension is unavailable"),
    });
  });
});
