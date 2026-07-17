import {
  errorPayload,
  parseResponseEnvelope,
  ProviderError,
  requestEnvelope,
  type ProviderRequest,
  type ResponsePayload,
} from "./protocol";

// The dApp-facing wallet provider (technical-doc.md §5.3: "extension exposes
// a wallet provider interface for dApps"). Transport-injected so the same
// implementation is unit-testable and reusable over window.postMessage.

export interface PageTransport {
  /** Sends a request envelope toward the extension (e.g. window.postMessage). */
  send(envelope: unknown): void;
  /** Subscribes to inbound messages; returns an unsubscribe function. */
  listen(handler: (data: unknown) => void): () => void;
}

export interface VelaProvider {
  connect(network: "testnet" | "mainnet"): Promise<{ address: string; network: string }>;
  getAddress(network: "testnet" | "mainnet"): Promise<{ address: string; network: string }>;
  signTransaction(input: { xdr: string; network: "testnet" | "mainnet" }): Promise<{
    signedXdr: string;
  }>;
  disconnect(): Promise<void>;
  /** Whether the extension is paired to exactly this wallet (no approval prompt). */
  pairStatus(input: {
    address: string;
    network: "testnet" | "mainnet";
  }): Promise<{ paired: boolean }>;
  /** Web-app pairing: asks the extension to become a device signer for the wallet. */
  pair(input: {
    address: string;
    network: "testnet" | "mainnet";
    rpcUrl: string;
    keyId: string;
    walletWasmHash: string;
  }): Promise<{
    devicePublicKeyHex: string;
  }>;
}

export interface PageProviderOptions {
  transport: PageTransport;
  /** Per-request timeout; approvals are human-paced, so default is generous. */
  timeoutMs?: number;
  newId?: () => string;
}

interface Pending {
  method: ProviderRequest["method"];
  resolve(payload: ResponsePayload): void;
}

export function createPageProvider(options: PageProviderOptions): VelaProvider {
  const timeoutMs = options.timeoutMs ?? 300_000;
  // crypto.randomUUID only exists in secure contexts; dApps on plain-http dev
  // origins still deserve a working provider. IDs only need to be unique
  // within this page session.
  const newId =
    options.newId ??
    (() =>
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  const pending = new Map<string, Pending>();

  options.transport.listen((data) => {
    const envelope = parseResponseEnvelope(data);
    if (!envelope) return;
    const entry = pending.get(envelope.id);
    if (!entry) return;
    pending.delete(envelope.id);
    entry.resolve(envelope.payload);
  });

  function call(request: ProviderRequest): Promise<ResponsePayload> {
    return new Promise((resolve) => {
      const id = newId();
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          resolve(errorPayload("rejected", `Request timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      pending.set(id, {
        method: request.method,
        resolve: (payload) => {
          clearTimeout(timer);
          resolve(payload);
        },
      });
      options.transport.send(requestEnvelope(id, request));
    });
  }

  function unwrap<T>(payload: ResponsePayload, method: ProviderRequest["method"]): T {
    if ("error" in payload) throw new ProviderError(payload.error.code, payload.error.message);
    if (payload.method !== method) {
      throw new ProviderError("internal", `Mismatched response method: ${payload.method}`);
    }
    return payload.result as T;
  }

  return {
    async connect(network) {
      const payload = await call({ method: "connect", params: { network } });
      return unwrap(payload, "connect");
    },
    async getAddress(network) {
      const payload = await call({ method: "get_address", params: { network } });
      return unwrap(payload, "get_address");
    },
    async signTransaction({ xdr, network }) {
      const payload = await call({ method: "sign_transaction", params: { xdr, network } });
      return unwrap(payload, "sign_transaction");
    },
    async disconnect() {
      const payload = await call({ method: "disconnect", params: {} });
      unwrap(payload, "disconnect");
    },
    async pair(params) {
      const payload = await call({ method: "pair", params });
      return unwrap(payload, "pair");
    },
    async pairStatus(params) {
      const payload = await call({ method: "pair_status", params });
      return unwrap(payload, "pair_status");
    },
  };
}

/** window.postMessage transport for real pages (same-window, extension bridge relays). */
export function createWindowTransport(
  win: Pick<Window, "postMessage" | "addEventListener" | "removeEventListener">,
): PageTransport {
  return {
    send(envelope) {
      win.postMessage(envelope, "*");
    },
    listen(handler) {
      const listener = (event: MessageEvent) => handler(event.data);
      win.addEventListener("message", listener as EventListener);
      return () => win.removeEventListener("message", listener as EventListener);
    },
  };
}
