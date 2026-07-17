import { describe, expect, it, vi } from "vitest";
import { createHttpWalletBackend, WalletApiError } from "./http-backend";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("submitWalletCreation", () => {
  it("POSTs the creation payload with serialized XDR and returns the session id", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(201, { txHash: "h", sessionId: "sess-1" }));
    const backend = createHttpWalletBackend("http://api.test/", fetchImpl);

    const result = await backend.submitWalletCreation({
      keyId: "k1",
      contractId: "C1",
      network: "testnet",
      signedTx: { toXDR: () => "xdr-string" },
    });
    expect(result).toEqual({ sessionId: "sess-1" });

    expect(fetchImpl).toHaveBeenCalledWith("http://api.test/wallet/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        keyId: "k1",
        contractId: "C1",
        network: "testnet",
        signedTx: "xdr-string",
      }),
    });
  });

  it("throws a WalletApiError carrying the server's message and code", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(502, {
        error: "relayer_not_configured",
        message: "Relayer is not configured.",
      }),
    );
    const backend = createHttpWalletBackend("http://api.test", fetchImpl);

    const attempt = backend.submitWalletCreation({
      keyId: "k1",
      contractId: "C1",
      network: "testnet",
      signedTx: "xdr",
    });

    await expect(attempt).rejects.toBeInstanceOf(WalletApiError);
    await expect(attempt).rejects.toMatchObject({
      status: 502,
      code: "relayer_not_configured",
      message: "Relayer is not configured.",
    });
  });

  it("copes with non-JSON error bodies", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("gateway exploded", { status: 500 }));
    const backend = createHttpWalletBackend("http://api.test", fetchImpl);
    await expect(
      backend.submitWalletCreation({
        keyId: "k",
        contractId: "C",
        network: "testnet",
        signedTx: "x",
      }),
    ).rejects.toMatchObject({ status: 500, message: "Wallet API request failed (500)" });
  });
});

describe("lookupContractId", () => {
  it("returns the contract and server session ids on success", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { contractId: "C9", sessionId: "s" }));
    const backend = createHttpWalletBackend("http://api.test", fetchImpl);
    await expect(backend.lookupContractId({ keyId: "k", network: "testnet" })).resolves.toEqual({
      contractId: "C9",
      sessionId: "s",
    });
  });

  it("returns undefined for an unknown passkey (404)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, { error: "wallet_not_found" }));
    const backend = createHttpWalletBackend("http://api.test", fetchImpl);
    await expect(
      backend.lookupContractId({ keyId: "k", network: "testnet" }),
    ).resolves.toBeUndefined();
  });

  it("throws on other failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" }));
    const backend = createHttpWalletBackend("http://api.test", fetchImpl);
    await expect(
      backend.lookupContractId({ keyId: "k", network: "testnet" }),
    ).rejects.toBeInstanceOf(WalletApiError);
  });
});

describe("submitTransaction", () => {
  it("POSTs the signed XDR and returns the hash", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { hash: "abc" }));
    const backend = createHttpWalletBackend("http://api.test", fetchImpl);
    await expect(
      backend.submitTransaction({ signedXdr: "xdr", network: "testnet" }),
    ).resolves.toEqual({ hash: "abc" });
    expect(fetchImpl).toHaveBeenCalledWith("http://api.test/wallet/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedXdr: "xdr", network: "testnet" }),
    });
  });

  it("throws a WalletApiError with the relayer's message on failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(502, { error: "relayer_error", message: "fee too low" }));
    const backend = createHttpWalletBackend("http://api.test", fetchImpl);
    await expect(
      backend.submitTransaction({ signedXdr: "xdr", network: "testnet" }),
    ).rejects.toMatchObject({ status: 502, code: "relayer_error", message: "fee too low" });
  });
});

describe("listSessions", () => {
  it("GETs sessions with the account and network in the query", async () => {
    const record = {
      id: "s1",
      contractId: "C1",
      network: "testnet",
      createdAt: "2026-07-16T10:00:00.000Z",
      lastActiveAt: "2026-07-16T10:00:00.000Z",
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { sessions: [record] }));
    const backend = createHttpWalletBackend("http://api.test", fetchImpl);

    await expect(backend.listSessions({ contractId: "C1", network: "testnet" })).resolves.toEqual({
      sessions: [record],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://api.test/wallet/sessions?contractId=C1&network=testnet",
    );
  });

  it("throws on failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" }));
    const backend = createHttpWalletBackend("http://api.test", fetchImpl);
    await expect(
      backend.listSessions({ contractId: "C1", network: "testnet" }),
    ).rejects.toBeInstanceOf(WalletApiError);
  });
});

describe("revokeSession", () => {
  it("DELETEs the session", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const backend = createHttpWalletBackend("http://api.test", fetchImpl);
    await backend.revokeSession("sess-1");
    expect(fetchImpl).toHaveBeenCalledWith("http://api.test/wallet/session/sess-1", {
      method: "DELETE",
    });
  });

  it("treats an already-revoked session (404) as success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, { error: "session_not_found" }));
    const backend = createHttpWalletBackend("http://api.test", fetchImpl);
    await expect(backend.revokeSession("gone")).resolves.toBeUndefined();
  });

  it("throws on server failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" }));
    const backend = createHttpWalletBackend("http://api.test", fetchImpl);
    await expect(backend.revokeSession("s")).rejects.toBeInstanceOf(WalletApiError);
  });
});
