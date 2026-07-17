import { describe, expect, it, vi } from "vitest";
import { createPageProvider, type PageTransport } from "./page-provider";
import {
  errorPayload,
  parseRequestEnvelope,
  ProviderError,
  responseEnvelope,
  type ResponsePayload,
} from "./protocol";

/** Transport harness: captures outbound envelopes, lets tests answer them. */
function harness(answer?: (id: string, method: string) => ResponsePayload | undefined) {
  let inbound: (data: unknown) => void = () => {};
  const sent: Array<{ id: string; method: string }> = [];
  const transport: PageTransport = {
    send(data) {
      const envelope = parseRequestEnvelope(data);
      if (!envelope) throw new Error("provider sent an invalid envelope");
      sent.push({ id: envelope.id, method: envelope.request.method });
      const payload = answer?.(envelope.id, envelope.request.method);
      if (payload) queueMicrotask(() => inbound(responseEnvelope(envelope.id, payload)));
    },
    listen(handler) {
      inbound = handler;
      return () => {};
    },
  };
  return { transport, sent, respond: (data: unknown) => inbound(data) };
}

describe("createPageProvider", () => {
  it("connect resolves with the approved address", async () => {
    const { transport } = harness(() => ({
      method: "connect",
      result: { address: "CABC", network: "testnet" },
    }));
    const provider = createPageProvider({ transport });
    await expect(provider.connect("testnet")).resolves.toEqual({
      address: "CABC",
      network: "testnet",
    });
  });

  it("pair resolves with the device public key", async () => {
    const hex = "ab".repeat(32);
    const { transport, sent } = harness(() => ({
      method: "pair",
      result: { devicePublicKeyHex: hex },
    }));
    const provider = createPageProvider({ transport });
    await expect(
      provider.pair({
        address: "CABC",
        network: "testnet",
        rpcUrl: "https://rpc.test",
        keyId: "key-1",
        walletWasmHash: "ab".repeat(32),
      }),
    ).resolves.toEqual({
      devicePublicKeyHex: hex,
    });
    expect(sent[0]?.method).toBe("pair");
  });

  it("pairStatus resolves with the paired flag", async () => {
    const { transport } = harness(() => ({ method: "pair_status", result: { paired: true } }));
    const provider = createPageProvider({ transport });
    await expect(provider.pairStatus({ address: "CABC", network: "testnet" })).resolves.toEqual({
      paired: true,
    });
  });

  it("signTransaction resolves with the signed XDR", async () => {
    const { transport } = harness(() => ({
      method: "sign_transaction",
      result: { signedXdr: "SIGNED" },
    }));
    const provider = createPageProvider({ transport });
    await expect(provider.signTransaction({ xdr: "AAAA", network: "testnet" })).resolves.toEqual({
      signedXdr: "SIGNED",
    });
  });

  it("rejections surface as ProviderError with the code", async () => {
    const { transport } = harness(() => errorPayload("rejected", "user declined"));
    const provider = createPageProvider({ transport });
    const attempt = provider.connect("testnet");
    await expect(attempt).rejects.toBeInstanceOf(ProviderError);
    await expect(attempt).rejects.toMatchObject({ code: "rejected", message: "user declined" });
  });

  it("correlates concurrent requests by id, ignoring foreign/unknown messages", async () => {
    const { transport, sent, respond } = harness();
    const provider = createPageProvider({ transport });

    const first = provider.getAddress("testnet");
    const second = provider.getAddress("mainnet");
    expect(sent).toHaveLength(2);

    // Noise on the channel must be ignored.
    respond({ random: "spam" });
    respond(responseEnvelope("never-sent-id", errorPayload("internal", "spoof")));

    // Answer out of order.
    respond(
      responseEnvelope(sent[1]!.id, {
        method: "get_address",
        result: { address: "C-MAIN", network: "mainnet" },
      }),
    );
    respond(
      responseEnvelope(sent[0]!.id, {
        method: "get_address",
        result: { address: "C-TEST", network: "testnet" },
      }),
    );

    await expect(second).resolves.toEqual({ address: "C-MAIN", network: "mainnet" });
    await expect(first).resolves.toEqual({ address: "C-TEST", network: "testnet" });
  });

  it("a mismatched response method is an internal error, not silent corruption", async () => {
    const { transport, sent, respond } = harness();
    const provider = createPageProvider({ transport });
    const attempt = provider.connect("testnet");
    respond(responseEnvelope(sent[0]!.id, { method: "disconnect", result: {} }));
    await expect(attempt).rejects.toMatchObject({ code: "internal" });
  });

  it("times out unanswered requests as rejected", async () => {
    vi.useFakeTimers();
    try {
      const { transport } = harness(); // never answers
      const provider = createPageProvider({ transport, timeoutMs: 5_000 });
      const attempt = expect(provider.connect("testnet")).rejects.toMatchObject({
        code: "rejected",
      });
      await vi.advanceTimersByTimeAsync(5_001);
      await attempt;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a late response after timeout is ignored (no double settle)", async () => {
    vi.useFakeTimers();
    try {
      const { transport, sent, respond } = harness();
      const provider = createPageProvider({ transport, timeoutMs: 5_000 });
      const attempt = expect(provider.connect("testnet")).rejects.toMatchObject({
        code: "rejected",
      });
      await vi.advanceTimersByTimeAsync(5_001);
      await attempt;
      respond(
        responseEnvelope(sent[0]!.id, {
          method: "connect",
          result: { address: "CLATE", network: "testnet" },
        }),
      );
      // Nothing to assert beyond "does not throw/settle twice" — reaching here is the test.
    } finally {
      vi.useRealTimers();
    }
  });
});
