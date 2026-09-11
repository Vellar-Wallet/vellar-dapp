import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import { buildServer } from "../server";
import { FacilitatorError } from "../lib/errors";
import { signedProofXdr, stubFacilitator, TEST_PASSPHRASE } from "../test-support";
import type { FacilitatorApi } from "../lib/facilitator";

let app: FastifyInstance | undefined;

function build(facilitator: FacilitatorApi = stubFacilitator(), fetchImpl?: typeof fetch) {
  app = buildServer({ facilitator, networkPassphrase: TEST_PASSPHRASE, fetchImpl });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const RESOURCE = "https://api.example.com/weather";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("POST /marketplace/payments/quote", () => {
  it("returns the challenge for a 402 resource", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(402, {
        x402Version: 1,
        accepts: [
          { scheme: "exact", asset: "USDC", maxAmountRequired: "1000", payTo: "GSELLER" },
        ],
      }),
    ) as unknown as typeof fetch;
    const res = await build(stubFacilitator(), fetchImpl).inject({
      method: "POST",
      url: "/marketplace/payments/quote",
      payload: { resourceUrl: RESOURCE, walletAddress: Keypair.random().publicKey() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      free: false,
      price: "1000",
      asset: "USDC",
      scheme: "exact",
      payTo: "GSELLER",
      areFeesSponsored: true,
    });
  });

  it("reports a free resource when it answers 200", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { ok: true })) as unknown as typeof fetch;
    const res = await build(stubFacilitator(), fetchImpl).inject({
      method: "POST",
      url: "/marketplace/payments/quote",
      payload: { resourceUrl: RESOURCE, walletAddress: Keypair.random().publicKey() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ free: true, areFeesSponsored: true });
  });

  it("signs nothing — the quote is read-only", async () => {
    const settle = vi.fn();
    const verify = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(402, { accepts: [] })) as unknown as typeof fetch;
    await build(stubFacilitator({ settle, verify }), fetchImpl).inject({
      method: "POST",
      url: "/marketplace/payments/quote",
      payload: { resourceUrl: RESOURCE, walletAddress: Keypair.random().publicKey() },
    });
    expect(verify).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("surfaces an unreachable resource as 502", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    const res = await build(stubFacilitator(), fetchImpl).inject({
      method: "POST",
      url: "/marketplace/payments/quote",
      payload: { resourceUrl: RESOURCE, walletAddress: Keypair.random().publicKey() },
    });
    expect(res.statusCode).toBe(502);
  });

  it("rejects a non-URL resourceUrl", async () => {
    const res = await build().inject({
      method: "POST",
      url: "/marketplace/payments/quote",
      payload: { resourceUrl: "not-a-url", walletAddress: Keypair.random().publicKey() },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /marketplace/payments/pay", () => {
  const payer = Keypair.random();

  function payload(overrides: Record<string, unknown> = {}) {
    return {
      resourceUrl: RESOURCE,
      signedXdr: signedProofXdr(payer),
      walletAddress: payer.publicKey(),
      maxAmount: "1000",
      ...overrides,
    };
  }

  it("verifies then settles, and returns the content and hash", async () => {
    const verify = vi.fn().mockResolvedValue({ isValid: true });
    const settle = vi.fn().mockResolvedValue({
      content: "sunny",
      txHash: "hash-1",
      ledger: 99,
      amountPaid: "900",
      asset: "USDC",
    });
    const res = await build(stubFacilitator({ verify, settle })).inject({
      method: "POST",
      url: "/marketplace/payments/pay",
      payload: payload(),
    });
    expect(res.statusCode).toBe(200);
    expect(verify).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledOnce();
    expect(res.json()).toEqual({
      content: "sunny",
      txHash: "hash-1",
      ledger: 99,
      amountPaid: "900",
      asset: "USDC",
    });
  });

  it("returns 401 when the XDR is not signed by walletAddress", async () => {
    const settle = vi.fn();
    const other = Keypair.random();
    const res = await build(stubFacilitator({ settle })).inject({
      method: "POST",
      url: "/marketplace/payments/pay",
      // Signed by `payer`, but claiming to be `other`.
      payload: payload({ walletAddress: other.publicKey() }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_signature");
    // Crucially: an unverified payment never reaches the facilitator.
    expect(settle).not.toHaveBeenCalled();
  });

  it("returns 401 for a signature made on a different network", async () => {
    const res = await build().inject({
      method: "POST",
      url: "/marketplace/payments/pay",
      payload: payload({
        signedXdr: signedProofXdr(payer, "Public Global Stellar Network ; September 2015"),
      }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("does not settle when the facilitator rejects the authorization", async () => {
    const settle = vi.fn();
    const verify = vi.fn().mockResolvedValue({ isValid: false, invalidReason: "insufficient_funds" });
    const res = await build(stubFacilitator({ verify, settle })).inject({
      method: "POST",
      url: "/marketplace/payments/pay",
      payload: payload(),
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().message).toBe("insufficient_funds");
    expect(settle).not.toHaveBeenCalled();
  });

  it("propagates a facilitator failure", async () => {
    const settle = vi
      .fn()
      .mockRejectedValue(new FacilitatorError(500, "settle exploded", 502));
    const res = await build(stubFacilitator({ settle })).inject({
      method: "POST",
      url: "/marketplace/payments/pay",
      payload: payload(),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("facilitator_error");
  });

  it("rejects a non-numeric maxAmount", async () => {
    const res = await build().inject({
      method: "POST",
      url: "/marketplace/payments/pay",
      payload: payload({ maxAmount: "1.5" }),
    });
    expect(res.statusCode).toBe(400);
  });
});
