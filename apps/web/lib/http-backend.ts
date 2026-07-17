import {
  defaultSignedToXdr,
  type PaymentSubmitBackend,
  type WalletBackend,
} from "@vela/wallet-sdk";

// HTTP implementation of the WalletBackend seam, talking to the api-gateway's
// Wallet API (idea.md §11). The relayer key stays server-side; the browser
// only ever ships signed XDR to our own backend.

export class WalletApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "WalletApiError";
    this.status = status;
    this.code = code;
  }
}

async function toApiError(res: Response): Promise<WalletApiError> {
  let payload: { error?: string; message?: string } | undefined;
  try {
    payload = (await res.json()) as { error?: string; message?: string };
  } catch {
    // Non-JSON error body — fall through to the generic message.
  }
  return new WalletApiError(
    payload?.message ?? payload?.error ?? `Wallet API request failed (${res.status})`,
    res.status,
    payload?.error,
  );
}

export interface SessionRecord {
  id: string;
  contractId: string;
  network: string;
  createdAt: string;
  lastActiveAt: string;
}

export interface WalletApiClient extends WalletBackend, PaymentSubmitBackend {
  listSessions(input: {
    contractId: string;
    network: string;
  }): Promise<{ sessions: SessionRecord[] }>;
  /** Revoking an already-gone session is a no-op, not an error. */
  revokeSession(id: string): Promise<void>;
}

export function createHttpWalletBackend(
  apiUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): WalletApiClient {
  const base = apiUrl.replace(/\/+$/, "");

  async function post(path: string, body: unknown): Promise<Response> {
    return fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  return {
    async submitWalletCreation({ keyId, contractId, network, signedTx }) {
      const res = await post("/wallet/create", {
        keyId,
        contractId,
        network,
        signedTx: defaultSignedToXdr(signedTx),
      });
      if (!res.ok) throw await toApiError(res);
      const data = (await res.json()) as { sessionId: string };
      return { sessionId: data.sessionId };
    },

    async lookupContractId({ keyId, network }) {
      const res = await post("/wallet/connect", { keyId, network });
      if (res.status === 404) return undefined;
      if (!res.ok) throw await toApiError(res);
      return (await res.json()) as { contractId: string; sessionId: string };
    },

    async submitTransaction({ signedXdr, network }) {
      const res = await post("/wallet/submit", { signedXdr, network });
      if (!res.ok) throw await toApiError(res);
      return (await res.json()) as { hash: string };
    },

    // Session/device management (technical-doc.md §5.1).
    async listSessions({ contractId, network }: { contractId: string; network: string }) {
      const query = new URLSearchParams({ contractId, network });
      const res = await fetchImpl(`${base}/wallet/sessions?${query}`);
      if (!res.ok) throw await toApiError(res);
      return (await res.json()) as { sessions: SessionRecord[] };
    },

    async revokeSession(id: string) {
      const res = await fetchImpl(`${base}/wallet/session/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404) throw await toApiError(res);
    },
  };
}
