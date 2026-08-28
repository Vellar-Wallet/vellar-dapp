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

import { sanitizeString } from "./sanitization";

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
  const cleanOrigin = sanitizeString(origin);

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
    return { kind: "needs-approval", origin: cleanOrigin };
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

  if (request.method !== "disconnect" && request.params.network !== wallet.network) {
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
      return { kind: "needs-approval", origin: cleanOrigin };
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
      return { kind: "needs-approval", origin: cleanOrigin };
    }

    case "disconnect": {
      return respond({ method: "disconnect", result: {} }, true);
    }
  }
}
