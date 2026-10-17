import { describe, expect, it } from "vitest";
import type { PermissionGrant, ProviderRequest } from "@vellar/provider-sdk";
import { createConcurrentRequestQueue, routeProviderRequest } from "./router";
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

  describe("concurrent dApp requests from different tabs targeting the same wallet (#582)", () => {
    const TAB_A_ORIGIN = "https://dex-a.example";
    const TAB_B_ORIGIN = "https://lending-b.example";

    it("queues two concurrent connect requests from different tabs without overwriting each other and isolates approval/rejection state", async () => {
      const queue = createConcurrentRequestQueue(paired);

      const tabAPromise = queue.submit({
        id: "req-tab-a-connect",
        tabId: 101,
        origin: TAB_A_ORIGIN,
        request: { method: "connect", params: { network: "testnet" } },
      });

      const tabBPromise = queue.submit({
        id: "req-tab-b-connect",
        tabId: 202,
        origin: TAB_B_ORIGIN,
        request: { method: "connect", params: { network: "testnet" } },
      });

      // Both requests are queued concurrently and neither overwrote the other.
      expect(queue.listPending()).toEqual([
        {
          id: "req-tab-a-connect",
          tabId: 101,
          origin: TAB_A_ORIGIN,
          request: { method: "connect", params: { network: "testnet" } },
        },
        {
          id: "req-tab-b-connect",
          tabId: 202,
          origin: TAB_B_ORIGIN,
          request: { method: "connect", params: { network: "testnet" } },
        },
      ]);

      // Approve Tab A and reject Tab B.
      expect(
        queue.resolvePending("req-tab-a-connect", true, {
          nowIso: "2026-07-16T12:00:00.000Z",
        }),
      ).toBe(true);
      expect(queue.resolvePending("req-tab-b-connect", false)).toBe(true);

      await expect(tabAPromise).resolves.toEqual({
        method: "connect",
        result: { address: "CABC", network: "testnet" },
      });
      await expect(tabBPromise).resolves.toEqual({
        error: { code: "rejected", message: "The user declined the request" },
      });

      expect(queue.listPending()).toEqual([]);

      // State contains a grant ONLY for Tab A; Tab B has zero capabilities.
      const finalState = queue.getState();
      expect(finalState.grants).toHaveLength(1);
      expect(finalState.grants[0]?.origin).toBe(TAB_A_ORIGIN);

      // Follow-up get_address from Tab A succeeds immediately, while Tab B is unauthorized.
      await expect(
        queue.submit({
          id: "req-tab-a-addr",
          tabId: 101,
          origin: TAB_A_ORIGIN,
          request: { method: "get_address", params: { network: "testnet" } },
        }),
      ).resolves.toEqual({
        method: "get_address",
        result: { address: "CABC", network: "testnet" },
      });

      await expect(
        queue.submit({
          id: "req-tab-b-addr",
          tabId: 202,
          origin: TAB_B_ORIGIN,
          request: { method: "get_address", params: { network: "testnet" } },
        }),
      ).resolves.toMatchObject({
        error: { code: "unauthorized" },
      });
    });

    it("handles two concurrent sign_transaction requests from different connected tabs independently when one is rejected and the other approved", async () => {
      const bothGrantedState: ExtensionState = {
        ...paired,
        grants: [
          {
            origin: TAB_A_ORIGIN,
            accountId: "CABC",
            network: "testnet",
            capabilities: ["connect", "view_address", "sign"],
            grantedAt: "2026-07-16T10:00:00.000Z",
          },
          {
            origin: TAB_B_ORIGIN,
            accountId: "CABC",
            network: "testnet",
            capabilities: ["connect", "view_address", "sign"],
            grantedAt: "2026-07-16T10:05:00.000Z",
          },
        ],
      };

      const queue = createConcurrentRequestQueue(bothGrantedState);

      const signAPromise = queue.submit({
        id: "req-sign-a",
        tabId: 101,
        origin: TAB_A_ORIGIN,
        request: {
          method: "sign_transaction",
          params: { xdr: "XDR_SWAP_TAB_A", network: "testnet" },
        },
      });

      const signBPromise = queue.submit({
        id: "req-sign-b",
        tabId: 202,
        origin: TAB_B_ORIGIN,
        request: {
          method: "sign_transaction",
          params: { xdr: "XDR_BORROW_TAB_B", network: "testnet" },
        },
      });

      expect(queue.listPending()).toHaveLength(2);

      // Reject Tab A's transaction first, then approve Tab B's transaction.
      expect(queue.resolvePending("req-sign-a", false)).toBe(true);
      expect(
        queue.resolvePending("req-sign-b", true, {
          signedXdr: "SIGNED_XDR_BORROW_TAB_B",
        }),
      ).toBe(true);

      await expect(signAPromise).resolves.toEqual({
        error: { code: "rejected", message: "The user declined the request" },
      });
      await expect(signBPromise).resolves.toEqual({
        method: "sign_transaction",
        result: { signedXdr: "SIGNED_XDR_BORROW_TAB_B" },
      });

      // Both tabs retain their grants; rejecting a single tx never revokes either tab's grant.
      expect(queue.getState().grants.map((g) => g.origin)).toEqual([TAB_A_ORIGIN, TAB_B_ORIGIN]);
    });

    it("disconnecting from one tab while another tab has an in-flight sign_transaction does not affect the other tab", async () => {
      const bothGrantedState: ExtensionState = {
        ...paired,
        grants: [
          {
            origin: TAB_A_ORIGIN,
            accountId: "CABC",
            network: "testnet",
            capabilities: ["connect", "view_address", "sign"],
            grantedAt: "2026-07-16T10:00:00.000Z",
          },
          {
            origin: TAB_B_ORIGIN,
            accountId: "CABC",
            network: "testnet",
            capabilities: ["connect", "view_address", "sign"],
            grantedAt: "2026-07-16T10:05:00.000Z",
          },
        ],
      };

      const queue = createConcurrentRequestQueue(bothGrantedState);

      const signBPromise = queue.submit({
        id: "req-sign-b",
        tabId: 202,
        origin: TAB_B_ORIGIN,
        request: {
          method: "sign_transaction",
          params: { xdr: "XDR_TAB_B", network: "testnet" },
        },
      });

      // Tab A disconnects while Tab B's sign_transaction is awaiting approval.
      const disconnectAResult = await queue.submit({
        id: "req-disconnect-a",
        tabId: 101,
        origin: TAB_A_ORIGIN,
        request: { method: "disconnect", params: {} },
      });
      expect(disconnectAResult).toEqual({ method: "disconnect", result: {} });

      // Only Tab A's grant was revoked; Tab B's pending approval is still intact and resolves.
      expect(queue.getState().grants.map((g) => g.origin)).toEqual([TAB_B_ORIGIN]);
      expect(queue.listPending()).toHaveLength(1);

      queue.resolvePending("req-sign-b", true, { signedXdr: "SIGNED_XDR_TAB_B" });
      await expect(signBPromise).resolves.toEqual({
        method: "sign_transaction",
        result: { signedXdr: "SIGNED_XDR_TAB_B" },
      });
    });
  });
});
