import { z } from "zod";

// dApp <-> extension message protocol (technical-doc.md §5.3, §12).
// Every message crossing a trust boundary (page <-> content script <->
// background) is validated against these schemas; malformed input is rejected
// before it reaches approval logic (§8.2 spoofed-request protection).

export const PROVIDER_CHANNEL = "vela-provider" as const;

export const networkSchema = z.enum(["testnet", "mainnet"]);

// --- Requests (dApp -> extension) ---

export const connectRequestSchema = z.object({
  method: z.literal("connect"),
  params: z.object({
    network: networkSchema,
  }),
});

export const signTransactionRequestSchema = z.object({
  method: z.literal("sign_transaction"),
  params: z.object({
    xdr: z.string().min(1),
    network: networkSchema,
  }),
});

export const getAddressRequestSchema = z.object({
  method: z.literal("get_address"),
  params: z.object({
    network: networkSchema,
  }),
});

export const disconnectRequestSchema = z.object({
  method: z.literal("disconnect"),
  params: z.object({}),
});

// Pairing (technical-doc.md §7.2, docs/decisions.md device-signer): the web
// app asks the extension to pair with the connected wallet. Always requires
// explicit approval in the extension popup; the response carries the device
// signer's raw public key (hex) for the passkey-approved addEd25519 tx.
export const pairRequestSchema = z.object({
  method: z.literal("pair"),
  params: z.object({
    address: z.string().min(1),
    network: networkSchema,
    /** Soroban RPC endpoint the extension should use for this wallet. */
    rpcUrl: z.string().url(),
    /** The passkey's base64url credential id — lets the extension attach the
     * kit to the wallet without any WebAuthn ceremony (public data). */
    keyId: z.string().min(1),
    /** Canonical smart-wallet wasm hash the wallet was deployed from. */
    walletWasmHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});

// Pairing status probe: answered without approval, but only reveals whether
// THIS address+network is the paired one — the caller must already know the
// address to learn anything (no fingerprinting surface).
export const pairStatusRequestSchema = z.object({
  method: z.literal("pair_status"),
  params: z.object({
    address: z.string().min(1),
    network: networkSchema,
  }),
});

export const signAuthEntryRequestSchema = z.object({
  method: z.literal("sign_auth_entry"),
  params: z.object({
    authEntry: z.string().min(1),
    network: networkSchema,
  }),
});

export const signMessageRequestSchema = z.object({
  method: z.literal("sign_message"),
  params: z.object({
    message: z.string().min(1),
    network: networkSchema,
  }),
});

export const getNetworkRequestSchema = z.object({
  method: z.literal("get_network"),
  params: z.object({}).optional().default({}),
});

export const providerRequestSchema = z.discriminatedUnion("method", [
  connectRequestSchema,
  signTransactionRequestSchema,
  getAddressRequestSchema,
  disconnectRequestSchema,
  pairRequestSchema,
  pairStatusRequestSchema,
  signAuthEntryRequestSchema,
  signMessageRequestSchema,
  getNetworkRequestSchema,
]);

export type ProviderRequest = z.infer<typeof providerRequestSchema>;
export type ProviderMethod = ProviderRequest["method"];

// --- Responses (extension -> dApp) ---

export const providerErrorCodeSchema = z.enum([
  "rejected", // user declined the request
  "unauthorized", // origin lacks the required permission
  "disconnected", // no wallet is paired/connected in the extension
  "invalid_request", // schema validation failed
  "internal", // unexpected failure
  "paired_origin_limit_reached", // wallet already has the max paired dApp origins (#579)
]);

export type ProviderErrorCode = z.infer<typeof providerErrorCodeSchema>;

export const providerResultSchema = z.union([
  z.object({
    method: z.literal("connect"),
    result: z.object({ address: z.string().min(1), network: networkSchema }),
  }),
  z.object({
    method: z.literal("sign_transaction"),
    result: z.object({
      signedXdr: z.string().min(1),
      signedTxXdr: z.string().min(1).optional(),
      signerAddress: z.string().optional(),
    }),
  }),
  z.object({
    method: z.literal("get_address"),
    result: z.object({ address: z.string().min(1), network: networkSchema }),
  }),
  z.object({
    method: z.literal("disconnect"),
    result: z.object({}),
  }),
  z.object({
    method: z.literal("pair"),
    result: z.object({
      /** Raw Ed25519 public key, hex-encoded (32 bytes). */
      devicePublicKeyHex: z.string().regex(/^[0-9a-f]{64}$/, "must be 32 bytes of lowercase hex"),
    }),
  }),
  z.object({
    method: z.literal("pair_status"),
    result: z.object({ paired: z.boolean() }),
  }),
  z.object({
    method: z.literal("sign_auth_entry"),
    result: z.object({
      signedAuthEntry: z.string().min(1),
      signerAddress: z.string().optional(),
    }),
  }),
  z.object({
    method: z.literal("sign_message"),
    result: z.object({
      signedMessage: z.string().min(1),
      signerAddress: z.string().optional(),
    }),
  }),
  z.object({
    method: z.literal("get_network"),
    result: z.object({
      network: z.string().min(1),
      networkPassphrase: z.string().min(1),
    }),
  }),
]);

export const providerErrorSchema = z.object({
  error: z.object({
    code: providerErrorCodeSchema,
    message: z.string(),
  }),
});

// --- Envelopes (correlation across postMessage / runtime messaging) ---

// Schema version for protocol evolution. Increment when changing message
// shapes. Receiver must reject or handle mismatches gracefully.
export const PROTOCOL_VERSION = 1;

export const requestEnvelopeSchema = z.object({
  channel: z.literal(PROVIDER_CHANNEL),
  kind: z.literal("request"),
  id: z.string().min(1),
  version: z.number().int().default(PROTOCOL_VERSION),
  request: providerRequestSchema,
});

export const responseEnvelopeSchema = z.object({
  channel: z.literal(PROVIDER_CHANNEL),
  kind: z.literal("response"),
  id: z.string().min(1),
  version: z.number().int().default(PROTOCOL_VERSION),
  payload: z.union([providerResultSchema, providerErrorSchema]),
});

export type RequestEnvelope = z.infer<typeof requestEnvelopeSchema>;
export type ResponseEnvelope = z.infer<typeof responseEnvelopeSchema>;
export type ResponsePayload = ResponseEnvelope["payload"];

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
  }
}

/** Parses an untrusted inbound request envelope; undefined when not ours/invalid. */
export function parseRequestEnvelope(data: unknown): RequestEnvelope | undefined {
  const parsed = requestEnvelopeSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

/** Parses an untrusted inbound response envelope; undefined when not ours/invalid. */
export function parseResponseEnvelope(data: unknown): ResponseEnvelope | undefined {
  const parsed = responseEnvelopeSchema.safeParse(data);
  return parsed.success ? parsed.data : undefined;
}

export function requestEnvelope(id: string, request: ProviderRequest): RequestEnvelope {
  return { channel: PROVIDER_CHANNEL, kind: "request", id, request };
}

export function responseEnvelope(id: string, payload: ResponsePayload): ResponseEnvelope {
  return { channel: PROVIDER_CHANNEL, kind: "response", id, payload };
}

export function errorPayload(code: ProviderErrorCode, message: string): ResponsePayload {
  return { error: { code, message } };
}
