import {
  errorPayload,
  hasCapability,
  normalizeOrigin,
  type ProviderRequest,
  type ResponsePayload,
} from "@vellar/provider-sdk";
import { isPairOriginAllowed, type PairOriginPolicy } from "./pair-origins";
import type { ExtensionState } from "./state";

// Pure request router (technical-doc.md §7.3): decides, from validated
// request + TRUSTED origin (from the content-script sender, never the page)
// + stored state, whether to answer immediately or require explicit user
// approval. No silent signing: sign requests always require approval and are
// additionally gated on a prior connect grant (§5.3, §8.2).

export type RouteDecision =
  | { kind: "respond"; payload: ResponsePayload; revokeGrant?: boolean }
  | { kind: "needs-approval"; origin: string };

function respond(payload: ResponsePayload, revokeGrant?: boolean): RouteDecision {
  return revokeGrant ? { kind: "respond", payload, revokeGrant } : { kind: "respond", payload };
}

export function routeProviderRequest(
  request: ProviderRequest,
  rawOrigin: string,
  state: ExtensionState,
  // L3: which web-app origins may pair. Resolved fail-closed from the build
  // (see pair-origins.ts). Defaults to "any" so the pure router stays trivially
  // testable; the background worker always passes the real policy.
  pairOrigins: PairOriginPolicy = "any",
): RouteDecision {
  const origin = normalizeOrigin(rawOrigin);
  if (!origin) {
    return respond(errorPayload("invalid_request", "Requests from this origin are not supported"));
  }

  // Pairing is the one method that must work while nothing is paired yet.
  // Always requires explicit popup approval (origin + wallet shown), and the
  // subsequent addEd25519 still needs the user's passkey in the web app.
  if (request.method === "pair") {
    // L3: only the Vellar web app may pair — it becomes the deep-link target
    // and supplies the paired wallet's rpcUrl. An off-allowlist page is refused
    // before any popup so an attacker site can't poison webAppOrigin/rpcUrl.
    if (!isPairOriginAllowed(pairOrigins, origin)) {
      return respond(
        errorPayload("unauthorized", "This origin is not permitted to pair the Vellar extension"),
      );
    }
    return { kind: "needs-approval", origin };
  }

  // Status probe: no approval, but only confirms an address+network the
  // caller already knows — never enumerates what is paired.
  if (request.method === "pair_status") {
    const paired =
      state.pairedWallet?.address === request.params.address &&
      state.pairedWallet?.network === request.params.network;
    return respond({ method: "pair_status", result: { paired } });
  }

  const wallet = state.pairedWallet;
  if (!wallet) {
    return respond(
      errorPayload("disconnected", "No wallet is paired. Open the Vellar web app to pair."),
    );
  }

  if (
    request.method !== "disconnect" &&
    request.method !== "get_network" &&
    "network" in request.params &&
    request.params.network !== wallet.network
  ) {
    return respond(
      errorPayload(
        "disconnected",
        `The extension is paired on ${wallet.network}, not ${request.params.network}`,
      ),
    );
  }

  switch (request.method) {
    case "connect": {
      if (hasCapability(state.grants, origin, wallet.network, "connect")) {
        return respond({
          method: "connect",
          result: { address: wallet.address, network: wallet.network },
        });
      }
      return { kind: "needs-approval", origin };
    }

    case "get_address": {
      if (hasCapability(state.grants, origin, wallet.network, "view_address")) {
        return respond({
          method: "get_address",
          result: { address: wallet.address, network: wallet.network },
        });
      }
      return respond(errorPayload("unauthorized", "Connect first to view the address"));
    }

    case "sign_transaction": {
      if (!hasCapability(state.grants, origin, wallet.network, "sign")) {
        return respond(errorPayload("unauthorized", "Connect first to request signing"));
      }
      // Every transaction requires explicit approval — a grant only allows
      // the origin to ASK (§5.3 no silent signing).
      return { kind: "needs-approval", origin };
    }

    case "sign_auth_entry": {
      if (!hasCapability(state.grants, origin, wallet.network, "sign")) {
        return respond(errorPayload("unauthorized", "Connect first to request signing"));
      }
      // Auth entry signing requires explicit approval (no silent signing).
      return { kind: "needs-approval", origin };
    }

    case "sign_message": {
      if (!hasCapability(state.grants, origin, wallet.network, "sign")) {
        return respond(errorPayload("unauthorized", "Connect first to request signing"));
      }
      // Message signing requires explicit approval (no silent signing).
      return { kind: "needs-approval", origin };
    }

    case "get_network": {
      const networkPassphrase =
        wallet.network === "mainnet"
          ? "Public Global Stellar Network ; September 2015"
          : "Test SDF Network ; September 2015";
      return respond({
        method: "get_network",
        result: { network: wallet.network, networkPassphrase },
      });
    }

    case "disconnect": {
      return respond({ method: "disconnect", result: {} }, true);
    }
  }
}

export interface ConcurrentTabRequest {
  id: string;
  tabId: number;
  origin: string;
  request: ProviderRequest;
}

export interface PendingTabApproval {
  id: string;
  tabId: number;
  origin: string;
  request: ProviderRequest;
}

/**
 * Coordinates concurrent dApp provider requests arriving from multiple browser
 * tabs targeting the same wallet.
 *
 * Guarantees:
 * - Requests from distinct `(origin, method)` pairs across different tabs never
 *   overwrite or supersede one another in the pending approval queue.
 * - Approving one tab's request while rejecting another's mutates grants only
 *   for the approved origin and never cross-contaminates state or responses.
 */
export function createConcurrentRequestQueue(
  initialState: ExtensionState,
  pairOrigins: PairOriginPolicy = "any",
) {
  let state: ExtensionState = {
    pairedWallet: initialState.pairedWallet ? { ...initialState.pairedWallet } : undefined,
    grants: initialState.grants.map((g) => ({ ...g, capabilities: [...g.capabilities] })),
  };

  const pending = new Map<
    string,
    PendingTabApproval & { resolve: (payload: ResponsePayload) => void }
  >();

  function submit(req: ConcurrentTabRequest): Promise<ResponsePayload> {
    const decision = routeProviderRequest(req.request, req.origin, state, pairOrigins);
    if (decision.kind === "respond") {
      if (decision.revokeGrant && state.pairedWallet) {
        const normalized = normalizeOrigin(req.origin);
        state = {
          ...state,
          grants: state.grants.filter(
            (g) => !(g.origin === normalized && g.network === state.pairedWallet?.network),
          ),
        };
      }
      return Promise.resolve(decision.payload);
    }

    // Supersede only when BOTH normalized origin and method match. Concurrent
    // requests from different tabs/origins must coexist independently.
    for (const [oldId, existing] of pending) {
      if (existing.origin === decision.origin && existing.request.method === req.request.method) {
        existing.resolve(errorPayload("rejected", "Superseded by a newer request"));
        pending.delete(oldId);
      }
    }

    return new Promise<ResponsePayload>((resolve) => {
      pending.set(req.id, {
        id: req.id,
        tabId: req.tabId,
        origin: decision.origin,
        request: req.request,
        resolve,
      });
    });
  }

  function resolvePending(
    id: string,
    approved: boolean,
    options?: { signedXdr?: string; devicePublicKeyHex?: string; nowIso?: string },
  ): boolean {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);

    if (!approved) {
      entry.resolve(errorPayload("rejected", "The user declined the request"));
      return true;
    }

    if (entry.request.method === "pair") {
      const { address, network, rpcUrl, keyId, walletWasmHash } = entry.request.params;
      state = {
        ...state,
        pairedWallet: {
          address,
          network,
          rpcUrl,
          keyId,
          walletWasmHash,
          webAppOrigin: entry.origin,
        },
      };
      entry.resolve({
        method: "pair",
        result: { devicePublicKeyHex: options?.devicePublicKeyHex ?? "ab".repeat(32) },
      });
      return true;
    }

    const wallet = state.pairedWallet;
    if (!wallet) {
      entry.resolve(errorPayload("disconnected", "No wallet is paired"));
      return true;
    }

    if (entry.request.method === "connect") {
      const filtered = state.grants.filter(
        (g) => !(g.origin === entry.origin && g.network === wallet.network),
      );
      state = {
        ...state,
        grants: [
          ...filtered,
          {
            origin: entry.origin,
            accountId: wallet.address,
            network: wallet.network,
            capabilities: ["connect", "view_address", "sign"],
            grantedAt: options?.nowIso ?? new Date().toISOString(),
          },
        ],
      };
      entry.resolve({
        method: "connect",
        result: { address: wallet.address, network: wallet.network },
      });
      return true;
    }

    if (entry.request.method === "sign_transaction") {
      entry.resolve({
        method: "sign_transaction",
        result: { signedXdr: options?.signedXdr ?? `signed:${entry.request.params.xdr}` },
      });
      return true;
    }

    if (entry.request.method === "sign_auth_entry") {
      entry.resolve({
        method: "sign_auth_entry",
        result: { signedAuthEntry: `signed:${entry.request.params.authEntry}` },
      });
      return true;
    }

    if (entry.request.method === "sign_message") {
      entry.resolve({
        method: "sign_message",
        result: { signedMessage: `signed:${entry.request.params.message}` },
      });
      return true;
    }

    entry.resolve(errorPayload("internal", `Unexpected approval for ${entry.request.method}`));
    return true;
  }

  return {
    submit,
    resolvePending,
    listPending: (): PendingTabApproval[] =>
      [...pending.values()].map(({ id, tabId, origin, request }) => ({
        id,
        tabId,
        origin,
        request,
      })),
    getState: (): ExtensionState => ({
      pairedWallet: state.pairedWallet ? { ...state.pairedWallet } : undefined,
      grants: state.grants.map((g) => ({ ...g, capabilities: [...g.capabilities] })),
    }),
  };
}
