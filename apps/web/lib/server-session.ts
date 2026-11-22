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

interface ErrorLike {
  status?: unknown;
  code?: unknown;
  name?: unknown;
  message?: unknown;
}

function isExpiredServerSessionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as ErrorLike;
  const status = typeof e.status === "number" ? e.status : undefined;
  const code = typeof e.code === "string" ? e.code.toUpperCase() : "";
  const name = typeof e.name === "string" ? e.name.toUpperCase() : "";
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";

  if (status === 401 || status === 403 || status === 410) return true;
  if (
    code.includes("SESSION_EXPIRED") ||
    code.includes("SESSION_REVOKED") ||
    code.includes("SESSION_INVALID") ||
    code.includes("SESSION_NOT_FOUND")
  ) {
    return true;
  }
  if (name.includes("SESSIONEXPIRED") || name.includes("SESSIONREVOKED")) return true;

  return (
    message.includes("session expired") ||
    message.includes("session revoked") ||
    message.includes("session not found") ||
    message.includes("invalid session")
  );
}

export async function ensureServerSession(
  session: WalletSession,
  backend: Pick<WalletBackend, "lookupContractId">,
): Promise<WalletSession> {
  if (!session.keyId) {
    if (session.serverSessionId) {
      const { serverSessionId: _stale, ...withoutServerSession } = session;
      return withoutServerSession;
    }
    return session;
  }

  if (session.serverSessionId) {
    // Existing server session is present; callers can clear it explicitly when
    // backend operations report expiry/revocation. Keep it as-is here.
    return session;
  }

  let found: { contractId: string; sessionId: string } | undefined;
  try {
    found = await backend.lookupContractId({ keyId: session.keyId, network: session.network });
  } catch (err) {
    // A syntactically present but expired/revoked server session is a known
    // non-fatal reconnect case: keep the verified on-chain session but clear
    // any stale server session id so callers do not treat it as usable.
    if (isExpiredServerSessionError(err)) {
      const { serverSessionId: _stale, ...withoutServerSession } = session;
      return withoutServerSession;
    }
    throw err;
  }
  if (!found || found.contractId !== session.accountId) {
    const { serverSessionId: _stale, ...withoutServerSession } = session;
    return withoutServerSession;
  }
  return { ...session, serverSessionId: found.sessionId };
}
