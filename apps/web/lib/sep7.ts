import { Keypair, StrKey } from "@stellar/stellar-sdk";
import type { Network } from "@vellar/types";
import { findClassicAsset, nativeAsset, type RegisteredAsset } from "./assets";

// SEP-7 `pay` URIs (https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md, v2.1.0).
//
// Generation is for the receive screen; parsing is for incoming requests.
// An incoming URI is UNTRUSTED input from an external party (technical-doc.md
// §8.1): the parser is deny-by-default — it rejects anything it cannot honour
// exactly (unknown or duplicate params, malformed encoding, a memo the
// smart-account send path cannot carry, a callback it would not call) rather
// than silently turning the request into a different payment. A parsed request
// only ever PREFILLS the send flow; signing still needs the normal review +
// passkey approval.
//
// C-addresses: SEP-7 v2.1.0 predates Soroban and defines `destination` as "a
// valid account ID or payment address". Vellar accounts are contract (C…)
// addresses, so a generated request is only payable by wallets that can send
// to a contract (a SAC transfer). Wallets limited to classic Payment ops cannot
// build a payment to a C-address at all — the request fails to build there; it
// cannot be misrouted to some other account. Incoming requests accept G… and
// C… destinations (muxed M… is rejected: the send path cannot carry the id).

export const SEP7_SCHEME = "web+stellar:";

const MAX_URI_LENGTH = 2048;
const MAX_MSG_LENGTH = 300;
const MAX_MEMO_TEXT_BYTES = 28;
const STELLAR_DECIMALS = 7;
// Classic amounts are int64 stroops: at most 922337203685.4775807.
const AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,7})?$/;
// Control characters, zero-width and bidi-override code points: they let a
// request render differently from what it says (e.g. a reversed address).
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;
const FQDN = /^(?=.{1,253}$)(?:(?!-)[a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/;

const PAY_PARAMS = new Set([
  "destination",
  "amount",
  "asset_code",
  "asset_issuer",
  "memo",
  "memo_type",
  "callback",
  "msg",
  "network_passphrase",
  "origin_domain",
  "signature",
]);

export type Sep7ErrorCode =
  | "not_a_string"
  | "too_long"
  | "bad_scheme"
  | "unsupported_operation"
  | "malformed"
  | "duplicate_param"
  | "unknown_param"
  | "missing_destination"
  | "invalid_destination"
  | "unsupported_destination"
  | "invalid_amount"
  | "invalid_asset"
  | "unregistered_asset"
  | "memo_unsupported"
  | "callback_unsupported"
  | "wrong_network"
  | "unsafe_text"
  | "invalid_origin";

export class Sep7Error extends Error {
  readonly code: Sep7ErrorCode;
  constructor(code: Sep7ErrorCode, message: string) {
    super(message);
    this.name = "Sep7Error";
    this.code = code;
  }
}

export interface Sep7PayRequest {
  destination: string;
  destinationKind: "account" | "contract";
  /** Decimal string exactly as requested; absent = payer chooses. */
  amount?: string;
  asset: RegisteredAsset;
  /** Off-chain note from the requester. Untrusted — render as text only. */
  msg?: string;
  /** Claimed origin. NOT verified by the parser — see verifySep7Origin. */
  originDomain?: string;
  signature?: string;
  /** The URI as received, for origin-signature verification. */
  uri: string;
}

export type Sep7ParseResult =
  { ok: true; request: Sep7PayRequest } | { ok: false; code: Sep7ErrorCode; error: string };

export interface Sep7Context {
  network: Network;
  networkPassphrase: string;
}

export function isValidAmount(amount: string): boolean {
  return AMOUNT_PATTERN.test(amount) && /[1-9]/.test(amount);
}

function destinationKind(address: string): "account" | "contract" | null {
  if (StrKey.isValidEd25519PublicKey(address)) return "account";
  if (StrKey.isValidContract(address)) return "contract";
  return null;
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

export interface BuildPayUriInput {
  destination: string;
  amount?: string;
  asset?: RegisteredAsset;
  memo?: string;
  msg?: string;
  /** Included unless the request is for the public network (SEP-7 default). */
  networkPassphrase?: string;
  network: Network;
}

/** Build a spec-valid `web+stellar:pay?…` URI. Every value is percent-encoded. */
export function buildPayUri(input: BuildPayUriInput): string {
  if (!destinationKind(input.destination)) {
    throw new Sep7Error("invalid_destination", "Destination must be a G… or C… address.");
  }
  const params: [string, string][] = [["destination", input.destination]];

  if (input.amount !== undefined && input.amount !== "") {
    if (!isValidAmount(input.amount)) {
      throw new Sep7Error(
        "invalid_amount",
        `Amount must be a positive number with at most ${STELLAR_DECIMALS} decimal places.`,
      );
    }
    params.push(["amount", input.amount]);
  }

  if (input.asset && input.asset.issuer) {
    params.push(["asset_code", input.asset.code], ["asset_issuer", input.asset.issuer]);
  }

  if (input.memo !== undefined && input.memo !== "") {
    if (utf8Length(input.memo) > MAX_MEMO_TEXT_BYTES || UNSAFE_TEXT.test(input.memo)) {
      throw new Sep7Error(
        "unsafe_text",
        `Memo must be at most ${MAX_MEMO_TEXT_BYTES} bytes of printable text.`,
      );
    }
    params.push(["memo", input.memo], ["memo_type", "MEMO_TEXT"]);
  }

  if (input.msg !== undefined && input.msg !== "") {
    if (input.msg.length > MAX_MSG_LENGTH || UNSAFE_TEXT.test(input.msg)) {
      throw new Sep7Error(
        "unsafe_text",
        `Message must be at most ${MAX_MSG_LENGTH} printable characters.`,
      );
    }
    params.push(["msg", input.msg]);
  }

  if (input.network !== "mainnet" && input.networkPassphrase) {
    params.push(["network_passphrase", input.networkPassphrase]);
  }

  const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return `${SEP7_SCHEME}pay?${query}`;
}

function fail(code: Sep7ErrorCode, error: string): Sep7ParseResult {
  return { ok: false, code, error };
}

function decode(raw: string): string | null {
  try {
    // application/x-www-form-urlencoded compatibility: `+` is a space
    // (URLSearchParams-built requests); a literal plus arrives as %2B.
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

/**
 * Parse and validate an incoming `web+stellar:pay` URI against the wallet's
 * network and token registry. Never throws; never has side effects.
 */
export function parsePayUri(input: unknown, ctx: Sep7Context): Sep7ParseResult {
  if (typeof input !== "string") return fail("not_a_string", "Payment request must be text.");
  const uri = input.trim();
  if (uri.length > MAX_URI_LENGTH) {
    return fail("too_long", "Payment request is too long.");
  }
  if (uri.slice(0, SEP7_SCHEME.length).toLowerCase() !== SEP7_SCHEME) {
    return fail("bad_scheme", "Not a Stellar payment request (expected web+stellar:).");
  }

  const rest = uri.slice(SEP7_SCHEME.length);
  const q = rest.indexOf("?");
  const operation = q === -1 ? rest : rest.slice(0, q);
  if (operation !== "pay") {
    return fail(
      "unsupported_operation",
      operation === "tx"
        ? "Transaction-signing requests (web+stellar:tx) aren't supported — only payment requests."
        : "Unsupported request type — only web+stellar:pay is supported.",
    );
  }
  if (q === -1 || q === rest.length - 1) {
    return fail("missing_destination", "Payment request has no destination.");
  }
  const query = rest.slice(q + 1);
  if (query.includes("#")) return fail("malformed", "Payment request is malformed.");

  const params = new Map<string, string>();
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return fail("malformed", "Payment request is malformed.");
    const key = decode(pair.slice(0, eq));
    const value = decode(pair.slice(eq + 1));
    if (key === null || value === null) {
      return fail("malformed", "Payment request contains invalid encoding.");
    }
    if (!PAY_PARAMS.has(key)) {
      return fail("unknown_param", "Payment request contains an unsupported field.");
    }
    if (params.has(key)) {
      return fail("duplicate_param", "Payment request repeats a field, so it is ambiguous.");
    }
    params.set(key, value);
  }

  const destination = params.get("destination");
  if (!destination) return fail("missing_destination", "Payment request has no destination.");
  if (StrKey.isValidMed25519PublicKey(destination)) {
    return fail(
      "unsupported_destination",
      "Muxed (M…) destinations aren't supported — the payment couldn't carry the account id.",
    );
  }
  const kind = destinationKind(destination);
  if (!kind) return fail("invalid_destination", "Destination isn't a valid Stellar address.");

  if (params.has("callback")) {
    return fail(
      "callback_unsupported",
      "This request asks for the signed payment to be sent to a callback URL, which Vellar doesn't do.",
    );
  }

  if (params.has("memo") || params.has("memo_type")) {
    // The smart-account send path is a Soroban token transfer re-enveloped by
    // the sponsor; it has nowhere to carry a memo. Paying an exchange-style
    // request without its memo can lose the funds, so refuse outright.
    return fail(
      "memo_unsupported",
      "This request needs a memo, which Vellar payments can't include yet. Paying without it could lose the funds.",
    );
  }

  const passphrase = params.get("network_passphrase");
  if (passphrase !== undefined && passphrase !== ctx.networkPassphrase) {
    return fail("wrong_network", "This request is for a different Stellar network.");
  }
  if (passphrase === undefined && ctx.network !== "mainnet") {
    // No passphrase means the public network (SEP-7). Refuse to pay a mainnet
    // request from a testnet wallet rather than guess.
    return fail("wrong_network", "This request is for the public network, not this wallet's.");
  }

  const code = params.get("asset_code");
  const issuer = params.get("asset_issuer");
  let asset: RegisteredAsset;
  if (code === undefined && issuer === undefined) {
    asset = nativeAsset(ctx.network);
  } else if (code === undefined || issuer === undefined) {
    return fail("invalid_asset", "Asset code and issuer must be given together.");
  } else if (!StrKey.isValidEd25519PublicKey(issuer) || !/^[A-Za-z0-9]{1,12}$/.test(code)) {
    return fail("invalid_asset", "Requested asset is malformed.");
  } else {
    const found = findClassicAsset(ctx.network, code, issuer);
    if (!found) {
      return fail("unregistered_asset", `${code} from this issuer isn't a supported asset.`);
    }
    asset = found;
  }

  const amount = params.get("amount");
  if (amount !== undefined && !isValidAmount(amount)) {
    return fail(
      "invalid_amount",
      `Amount must be a positive number with at most ${STELLAR_DECIMALS} decimal places.`,
    );
  }

  const msg = params.get("msg");
  if (msg !== undefined && (msg.length > MAX_MSG_LENGTH || UNSAFE_TEXT.test(msg))) {
    return fail("unsafe_text", "The request's message contains unsupported characters.");
  }

  const originDomain = params.get("origin_domain");
  const signature = params.get("signature");
  if (originDomain !== undefined) {
    if (!FQDN.test(originDomain)) {
      return fail("invalid_origin", "The request names an invalid origin domain.");
    }
    if (!signature) {
      return fail("invalid_origin", "The request claims an origin but isn't signed.");
    }
  } else if (signature !== undefined) {
    // A signature with no declared origin cannot be checked against any
    // domain's signing key — it is a malformed signed request, not a trust signal.
    return fail("invalid_origin", "The request is signed but names no origin domain.");
  }

  return {
    ok: true,
    request: {
      destination,
      destinationKind: kind,
      ...(amount !== undefined && { amount }),
      asset,
      ...(msg !== undefined && msg !== "" && { msg }),
      ...(originDomain !== undefined && { originDomain }),
      ...(signature !== undefined && { signature }),
      uri,
    },
  };
}

// ── Origin verification ─────────────────────────────────────────────────────

export type OriginVerification =
  | { status: "none" }
  | { status: "verified"; domain: string }
  | { status: "invalid"; domain: string; reason: string };

export interface OriginVerifyDeps {
  fetch: (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>;
  /** Last-seen URI_REQUEST_SIGNING_KEY per domain (SEP-7 step 5). */
  keyCache?: { get(domain: string): string | null; set(domain: string, key: string): void };
}

const SIGNATURE_PREFIX = "stellar.sep.7 - URI Scheme";

/** The SEP-7 signing payload: 35 zero bytes, 0x04, prefix, then the URI without its signature. */
export function sep7SignaturePayload(uriWithoutSignature: string): Uint8Array {
  const body = new TextEncoder().encode(SIGNATURE_PREFIX + uriWithoutSignature);
  const payload = new Uint8Array(36 + body.length);
  payload[35] = 4;
  payload.set(body, 36);
  return payload;
}

function stripSignature(uri: string): string | null {
  const match = /&signature=[^&]*$/.exec(uri);
  return match ? uri.slice(0, match.index) : null;
}

function signingKeyFromToml(toml: string): string | null {
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break; // top-level keys only
    const m = /^\s*URI_REQUEST_SIGNING_KEY\s*=\s*"([^"]*)"\s*(?:#.*)?$/.exec(line);
    if (m) return m[1] ?? null;
  }
  return null;
}

/**
 * Verify a request's claimed `origin_domain` per SEP-7: fetch the domain's
 * stellar.toml, read URI_REQUEST_SIGNING_KEY, check the ed25519 signature over
 * the URI. Anything short of a valid signature is "invalid" and the request
 * must not be signed. A request with no origin is "none" — it is shown as
 * coming from an unverified source.
 */
export async function verifySep7Origin(
  request: Sep7PayRequest,
  deps: OriginVerifyDeps,
): Promise<OriginVerification> {
  const domain = request.originDomain;
  if (!domain) return { status: "none" };
  const invalid = (reason: string): OriginVerification => ({ status: "invalid", domain, reason });

  const unsigned = stripSignature(request.uri);
  if (!unsigned || !request.signature) {
    return invalid("The signature must be the request's last field.");
  }

  let toml: string;
  try {
    const res = await deps.fetch(`https://${domain}/.well-known/stellar.toml`);
    if (!res.ok) return invalid("The origin's stellar.toml couldn't be loaded.");
    toml = await res.text();
  } catch {
    return invalid("The origin's stellar.toml couldn't be loaded.");
  }

  const key = signingKeyFromToml(toml);
  if (!key || !StrKey.isValidEd25519PublicKey(key)) {
    return invalid("The origin doesn't publish a request-signing key.");
  }

  const cached = deps.keyCache?.get(domain);
  if (cached && cached !== key) {
    return invalid("The origin's signing key changed since your last request from it.");
  }

  let signature: Uint8Array;
  try {
    signature = Uint8Array.from(atob(request.signature), (c) => c.charCodeAt(0));
  } catch {
    return invalid("The request's signature is malformed.");
  }

  let valid = false;
  try {
    // stellar-base copies both arguments with its own Buffer.from, so plain
    // Uint8Arrays are safe here without a browser Buffer global.
    valid = Keypair.fromPublicKey(key).verify(
      sep7SignaturePayload(unsigned) as Buffer,
      signature as Buffer,
    );
  } catch {
    valid = false;
  }
  if (!valid) return invalid("The request's signature doesn't match its origin.");

  deps.keyCache?.set(domain, key);
  return { status: "verified", domain };
}
