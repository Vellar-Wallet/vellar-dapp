import { describe, expect, it } from "vitest";
import type { PermissionGrant, ProviderRequest } from "@vellar/provider-sdk";
import { routeProviderRequest } from "./router";
import type { ExtensionState } from "./state";

const ORIGIN = "https://dapp.example";
// The web app permitted to pair. `pair` from any other origin is refused; the
// pre-existing tests that don't pass a policy get "any" (behavior unchanged).
const WEB_APP = "https://app.vellar.xyz";

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

  const pairFrom = (): ProviderRequest => ({
    method: "pair",
    params: {
      address: "CNEW",
      network: "testnet",
      rpcUrl: "https://rpc.test",
      keyId: "key-1",
      walletWasmHash: "ab".repeat(32),
    },
  });

  it("pair from an allowlisted web-app origin needs approval, even when nothing is paired", () => {
    // Allowlisted origin, nothing paired yet.
    expect(routeProviderRequest(pairFrom(), WEB_APP, { grants: [] }, [WEB_APP])).toEqual({
      kind: "needs-approval",
      origin: WEB_APP,
    });
    // Re-pairing while already paired also requires approval.
    expect(routeProviderRequest(pairFrom(), WEB_APP, granted, [WEB_APP])).toEqual({
      kind: "needs-approval",
      origin: WEB_APP,
    });
  });

  it("pair from an origin NOT on the allowlist is refused (L3)", () => {
    const decision = routeProviderRequest(pairFrom(), "https://evil.example", { grants: [] }, [
      WEB_APP,
    ]);
    expect(decision.kind).toBe("respond");
    if (decision.kind === "respond") {
      expect(decision.payload).toMatchObject({ error: { code: "unauthorized" } });
    }
  });

  it('the "any" policy (dev/escape-hatch) lets any origin pair', () => {
    expect(routeProviderRequest(pairFrom(), ORIGIN, { grants: [] }, "any")).toEqual({
      kind: "needs-approval",
      origin: ORIGIN,
    });
  });

  it("pair from a garbage origin is rejected before the allowlist check", () => {
    expectError({ grants: [] }, pairFrom(), "file:///etc", "invalid_request");
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

  it("sign_auth_entry routes to needs-approval when origin has sign grant", () => {
    const decision = routeProviderRequest(
      { method: "sign_auth_entry", params: { authEntry: "entry_xdr", network: "testnet" } },
      ORIGIN,
      granted,
    );
    expect(decision).toEqual({ kind: "needs-approval", origin: ORIGIN });
  });

  it("sign_message routes to needs-approval when origin has sign grant", () => {
    const decision = routeProviderRequest(
      { method: "sign_message", params: { message: "hello", network: "testnet" } },
      ORIGIN,
      granted,
    );
    expect(decision).toEqual({ kind: "needs-approval", origin: ORIGIN });
  });

  it("get_network responds directly with network info", () => {
    const decision = routeProviderRequest({ method: "get_network", params: {} }, ORIGIN, granted);
    expect(decision).toEqual({
      kind: "respond",
      payload: {
        method: "get_network",
        result: {
          network: "testnet",
          networkPassphrase: "Test SDF Network ; September 2015",
        },
      },
    });
  });

  // #582: two different tabs/origins, both paired to the same wallet, issuing
  // concurrent requests (e.g. both requesting a signature) must be handled
  // correctly and independently — distinct approval decisions for each, with
  // no cross-contamination of grants/state between them.
  it("two concurrent sign_transaction requests from different tab/origin contexts are independent", () => {
    const otherOrigin = "https://other-dapp.example";
    const otherGrant: PermissionGrant = {
      origin: otherOrigin,
      accountId: "CABC",
      network: "testnet",
      capabilities: ["connect", "view_address", "sign"],
      grantedAt: "2026-07-16T10:05:00.000Z",
    };
    const bothGranted: ExtensionState = { ...paired, grants: [grant, otherGrant] };

    const signRequest: ProviderRequest = {
      method: "sign_transaction",
      params: { xdr: "AAAA", network: "testnet" },
    };

    const decisionA = routeProviderRequest(signRequest, ORIGIN, bothGranted);
    const decisionB = routeProviderRequest(signRequest, otherOrigin, bothGranted);

    expect(decisionA).toEqual({ kind: "needs-approval", origin: ORIGIN });
    expect(decisionB).toEqual({ kind: "needs-approval", origin: otherOrigin });
    // Each decision carries its OWN origin — neither was overwritten by the other.
    expect(decisionA).not.toEqual(decisionB);
  });

  it("one concurrent origin lacking a grant is unauthorized while the other (granted) needs approval — no cross-contamination", () => {
    const otherOrigin = "https://other-dapp.example"; // no grant for this one
    const signRequest: ProviderRequest = {
      method: "sign_transaction",
      params: { xdr: "AAAA", network: "testnet" },
    };

    // `granted` only has a grant for ORIGIN; `otherOrigin` has none.
    const decisionGranted = routeProviderRequest(signRequest, ORIGIN, granted);
    const decisionUngranted = routeProviderRequest(signRequest, otherOrigin, granted);

    expect(decisionGranted).toEqual({ kind: "needs-approval", origin: ORIGIN });
    expect(decisionUngranted).toMatchObject({
      kind: "respond",
      payload: { error: { code: "unauthorized" } },
    });
  });
});
