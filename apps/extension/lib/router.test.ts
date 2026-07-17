import { describe, expect, it } from "vitest";
import type { PermissionGrant, ProviderRequest } from "@vela/provider-sdk";
import { routeProviderRequest } from "./router";
import type { ExtensionState } from "./state";

const ORIGIN = "https://dapp.example";

const grant: PermissionGrant = {
  origin: ORIGIN,
  accountId: "CABC",
  network: "testnet",
  capabilities: ["connect", "view_address", "sign"],
  grantedAt: "2026-07-16T10:00:00.000Z",
};

const paired: ExtensionState = {
  pairedWallet: {
    address: "CABC",
    network: "testnet",
    rpcUrl: "https://rpc.test",
    keyId: "key-1",
    walletWasmHash: "ab".repeat(32),
  },
  grants: [],
};

const granted: ExtensionState = { ...paired, grants: [grant] };

const connect: ProviderRequest = { method: "connect", params: { network: "testnet" } };

function expectError(
  state: ExtensionState,
  request: ProviderRequest,
  origin: string,
  code: string,
) {
  const decision = routeProviderRequest(request, origin, state);
  expect(decision.kind).toBe("respond");
  if (decision.kind === "respond") {
    expect(decision.payload).toMatchObject({ error: { code } });
  }
}

describe("routeProviderRequest", () => {
  it("rejects garbage origins outright", () => {
    expectError(granted, connect, "javascript:alert(1)", "invalid_request");
    expectError(granted, connect, "https://dapp.example/path", "invalid_request");
  });

  it("responds disconnected when no wallet is paired", () => {
    expectError({ grants: [] }, connect, ORIGIN, "disconnected");
  });

  it("responds disconnected on a network mismatch with the paired wallet", () => {
    expectError(
      granted,
      { method: "connect", params: { network: "mainnet" } },
      ORIGIN,
      "disconnected",
    );
  });

  it("requires approval for a first-time connect", () => {
    expect(routeProviderRequest(connect, ORIGIN, paired)).toEqual({
      kind: "needs-approval",
      origin: ORIGIN,
    });
  });

  it("answers connect immediately for an already-granted origin", () => {
    expect(routeProviderRequest(connect, ORIGIN, granted)).toEqual({
      kind: "respond",
      payload: { method: "connect", result: { address: "CABC", network: "testnet" } },
    });
  });

  it("get_address requires a prior grant", () => {
    const request: ProviderRequest = { method: "get_address", params: { network: "testnet" } };
    expectError(paired, request, ORIGIN, "unauthorized");
    expect(routeProviderRequest(request, ORIGIN, granted)).toMatchObject({
      kind: "respond",
      payload: { method: "get_address", result: { address: "CABC" } },
    });
  });

  it("sign_transaction is unauthorized without a grant, needs approval with one", () => {
    const request: ProviderRequest = {
      method: "sign_transaction",
      params: { xdr: "AAAA", network: "testnet" },
    };
    expectError(paired, request, ORIGIN, "unauthorized");
    // A grant only allows the origin to ASK — every tx still needs approval.
    expect(routeProviderRequest(request, ORIGIN, granted)).toEqual({
      kind: "needs-approval",
      origin: ORIGIN,
    });
  });

  it("disconnect responds ok and flags grant revocation", () => {
    expect(routeProviderRequest({ method: "disconnect", params: {} }, ORIGIN, granted)).toEqual({
      kind: "respond",
      payload: { method: "disconnect", result: {} },
      revokeGrant: true,
    });
  });

  it("pair always needs approval, even when nothing is paired yet", () => {
    const pair: ProviderRequest = {
      method: "pair",
      params: {
        address: "CNEW",
        network: "testnet",
        rpcUrl: "https://rpc.test",
        keyId: "key-1",
        walletWasmHash: "ab".repeat(32),
      },
    };
    expect(routeProviderRequest(pair, ORIGIN, { grants: [] })).toEqual({
      kind: "needs-approval",
      origin: ORIGIN,
    });
    // Re-pairing while already paired also requires approval.
    expect(routeProviderRequest(pair, ORIGIN, granted)).toEqual({
      kind: "needs-approval",
      origin: ORIGIN,
    });
  });

  it("pair from a garbage origin is still rejected", () => {
    expectError(
      { grants: [] },
      {
        method: "pair",
        params: {
          address: "CNEW",
          network: "testnet",
          rpcUrl: "https://rpc.test",
          keyId: "key-1",
          walletWasmHash: "ab".repeat(32),
        },
      },
      "file:///etc",
      "invalid_request",
    );
  });

  it("pair_status confirms a known address without approval, denies everything else", () => {
    const status = (address: string, network: "testnet" | "mainnet", state: ExtensionState) =>
      routeProviderRequest({ method: "pair_status", params: { address, network } }, ORIGIN, state);

    expect(status("CABC", "testnet", paired)).toEqual({
      kind: "respond",
      payload: { method: "pair_status", result: { paired: true } },
    });
    expect(status("CWRONG", "testnet", paired)).toMatchObject({
      payload: { method: "pair_status", result: { paired: false } },
    });
    expect(status("CABC", "mainnet", paired)).toMatchObject({
      payload: { method: "pair_status", result: { paired: false } },
    });
    expect(status("CABC", "testnet", { grants: [] })).toMatchObject({
      payload: { method: "pair_status", result: { paired: false } },
    });
  });

  it("a grant for one origin never leaks to another", () => {
    expect(routeProviderRequest(connect, "https://evil.example", granted)).toEqual({
      kind: "needs-approval",
      origin: "https://evil.example",
    });
  });
});
