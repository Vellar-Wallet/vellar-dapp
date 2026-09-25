import type { WalletSession } from "@vellar/types";
import type { WalletBackend } from "vellar-sdk";

// Reconnect must open a server session (#469).
//
// passkey-kit's connectWallet resolves the wallet by deterministic derivation
// FIRST and only falls back to our `getContractId` hook (POST /wallet/connect)
// when the derived instance isn't on-chain. For every wallet this app creates,
// the derived instance IS on-chain — so a plain "Sign in" never reached
// /wallet/connect, came back without a `serverSessionId`, and everything gated
// on the M1 bearer (Settings → sessions list / revoke) silently stayed empty.
//
// This closes that gap: when the connector returns no server session, open one
// explicitly. It is adopted only when the server maps this passkey to the SAME
// wallet the kit just verified on-chain — a server record pointing elsewhere is
// ignored rather than letting the bearer scope the UI to another account.

export async function ensureServerSession(
  session: WalletSession,
  backend: Pick<WalletBackend, "lookupContractId">,
): Promise<WalletSession> {
  if (session.serverSessionId || !session.keyId) return session;
  const found = await backend.lookupContractId({ keyId: session.keyId, network: session.network });
  if (!found || found.contractId !== session.accountId) return session;
  return { ...session, serverSessionId: found.sessionId };
}
