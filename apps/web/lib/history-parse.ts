// Pure history parsing/pagination/retry helpers (issue #403). SDK-free by
// design so unit tests exercise them directly; the Stellar decoder is passed in
// explicitly (rather than installed into a module-level global) so every
// consumer — the real client and the tests — decodes through the same path.

import type { HistoryAsset, HistoryDirection, HistoryTx } from "./history-types";

// --- Transient RPC failures (docs/adr-403-transaction-history.md) -------------

export const TRANSIENT_ERROR_CODES = ["txNoAccount", "txBadSeq", "MissingValue"] as const;

/**
 * Substrings that mark a stale/ephemeral view from the public testnet RPC's
 * load balancer. The ledger-range entry is the shape actually observed live
 * (`startLedger must be within the ledger range: A - B`): the node behind the
 * LB advertises a different window than the one we computed against, so the
 * read is retried after re-clamping rather than surfaced as "no history".
 */
const TRANSIENT_ERROR_PATTERNS: readonly string[] = [
  ...TRANSIENT_ERROR_CODES,
  "must be within the ledger range",
  "stale",
];

export class TransientHistoryError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Stale RPC view (${code}) — retry may succeed`);
    this.name = "TransientHistoryError";
    this.code = code;
  }
}

export function mapTransientRpcError(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err);
  const haystack = message.toLowerCase();
  for (const code of TRANSIENT_ERROR_PATTERNS) {
    if (haystack.includes(code.toLowerCase())) return new TransientHistoryError(code);
  }
  return err;
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Retries the documented testnet flake modes: the public RPC's load balancer
 * intermittently serves stale ledger views, so getEvents/getTransaction can
 * answer txNoAccount / txBadSeq / MissingValue for data that exists. Retries
 * with exponential backoff and rethrows the mapped error once attempts run
 * out, so callers can distinguish "empty history" from "temporarily
 * unreadable" instead of rendering a lying empty list.
 *
 * Only transient classes are retried. A 400 (e.g. Horizon rejecting a contract
 * address) is a permanent caller mistake and surfaces on the first attempt.
 */
export async function withTransientRetry<T>(
  run: () => Promise<T>,
  { retries = 4, baseDelayMs = 120, sleep = defaultSleep }: RetryOptions = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await run();
    } catch (err) {
      lastError = mapTransientRpcError(err);
      if (!(lastError instanceof TransientHistoryError) || attempt === retries) {
        throw lastError;
      }
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- base64url for the opaque page cursor (browser-safe) ---------------------
// Buffer is NOT available in the browser bundle (Next.js does not polyfill it)
// and this module runs in client code. btoa/atob cover the browser; Buffer is
// kept only as the Node fallback (unit tests, SSR).

function encodeBase64(input: string): string {
  if (typeof btoa === "function") {
    const bytes = new TextEncoder().encode(input);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  return Buffer.from(input, "utf8").toString("base64");
}

function decodeBase64(input: string): string {
  if (typeof atob === "function") {
    const binary = atob(input.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(input, "base64").toString("utf8");
}

// --- Page cursor packing (both rails ride in one opaque string) --------------

export function encodePageCursor(
  events: string | undefined,
  ops: string | undefined,
): string | undefined {
  if (!events && !ops) return undefined;
  const payload: Record<string, string> = {};
  if (events) payload.e = events;
  if (ops) payload.o = ops;
  return encodeBase64(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodePageCursor(
  cursor: string | undefined,
): { events?: string; ops?: string } | undefined {
  if (!cursor) return undefined;
  try {
    const parsed: unknown = JSON.parse(decodeBase64(cursor));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    const out: { events?: string; ops?: string } = {};
    if (typeof record.e === "string") out.events = record.e;
    if (typeof record.o === "string") out.ops = record.o;
    return out.events || out.ops ? out : undefined;
  } catch {
    return undefined;
  }
}

// --- SAC transfer events -----------------------------------------------------
// Verified live against both testnet SACs (docs/adr-403-transaction-history.md):
//   USDC SAC: topic = ["transfer", from, to, "USDC:GBBD…"]   value = i128
//   XLM  SAC: topic = ["transfer", from, to, "native"]         value = i128
// Both also emit unrelated events on the same contracts — "fee" with 2 topics
// and "approve" with 4 — so the match is by topic[0] AND a minimum topic
// count, never by an exact count.

/** The SDK's decoded ScVal → native. Injected so this module stays SDK-free. */
export type ScValDecoder = (scVal: unknown) => unknown;

export interface RawEvent {
  type: string;
  ledger: number;
  ledgerClosedAt?: string;
  id: string;
  txHash: string;
  inSuccessfulContractCall: boolean;
  topic: unknown[];
  value: unknown;
  /**
   * The contract that emitted the event. `stellar-sdk` hands back a StrKey
   * `Contract` OBJECT here, not a string — callers must normalise with
   * `String(...)` before using it as a lookup key.
   */
  contractId: unknown;
}

function decodeString(decoder: ScValDecoder, scVal: unknown): string | undefined {
  try {
    const value = decoder(scVal);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The contract id as a C… string, whatever the SDK handed us. */
export function contractIdOf(event: RawEvent): string {
  return String(event.contractId ?? "");
}

/**
 * A Soroban token transfer event.
 *
 * `topic.length >= 3` is load-bearing: the native XLM SAC and Circle USDC both
 * emit 4 topics, but SEP-41 also permits an implementation that carries the
 * amount in a `value` map behind a single topic. Requiring an exact count (as an
 * earlier draft did) silently dropped real transfers on any contract that
 * differs; requiring >= 3 keeps the 2-topic "fee" events out.
 */
export function isSACTransferEvent(event: RawEvent, decoder: ScValDecoder): boolean {
  return (
    event.type === "contract" &&
    Array.isArray(event.topic) &&
    event.topic.length >= 3 &&
    decodeString(decoder, event.topic[0]) === "transfer"
  );
}

/**
 * The transfer amount, in the asset's base units.
 *
 * The observed SAC shape is a bare i128 `value`. SEP-41 also permits a
 * structured value, so a map/vec carrying an `amount` key is unwrapped
 * defensively rather than dropped.
 */
function extractAmount(decoder: ScValDecoder, value: unknown, depth = 0): bigint | undefined {
  if (depth > 4) return undefined;
  if (typeof value === "bigint") return value;
  let native: unknown;
  try {
    native = decoder(value);
  } catch {
    return undefined;
  }
  if (typeof native === "bigint") return native;
  if (typeof native === "number" && Number.isFinite(native)) return BigInt(Math.trunc(native));
  if (typeof native === "string" && /^-?\d+$/.test(native)) {
    try {
      return BigInt(native);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(native)) {
    for (const element of native) {
      const found = extractAmount(decoder, element, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof native === "object" && native !== null && "amount" in native) {
    return extractAmount(decoder, (native as { amount: unknown }).amount, depth + 1);
  }
  return undefined;
}

export function parseSACTransfer(
  accountId: string,
  event: RawEvent,
  asset: HistoryAsset,
  decoder: ScValDecoder,
): HistoryTx | undefined {
  if (!isSACTransferEvent(event, decoder)) return undefined;
  const from = decodeString(decoder, event.topic[1]);
  const to = decodeString(decoder, event.topic[2]);
  if (!from || !to) return undefined;
  const amount = extractAmount(decoder, event.value);
  if (amount === undefined) return undefined;
  const contractId = contractIdOf(event);
  return {
    // Namespaced: event ids are only unique within one contract's emission, and
    // this id is the dashboard's de-duplication key across appended pages.
    id: `soroban:${contractId}:${event.id}`,
    kind: "soroban",
    direction: directionFor(accountId, from, to),
    counterparty: from === accountId ? to : from,
    amount,
    asset,
    timestamp: event.ledgerClosedAt ?? new Date(0).toISOString(),
    // A reverted contract call still tells the user "this did not go through",
    // which is exactly the question the history view exists to answer.
    status: event.inSuccessfulContractCall ? "success" : "failed",
    txHash: event.txHash,
  };
}

// --- Classic operations (Horizon ops endpoint) --------------------------------

export interface ClassicOp {
  id: string;
  type: string;
  transaction_successful: boolean;
  created_at: string;
  transaction_hash: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  amount?: string;
  from?: string;
  to?: string;
  account?: string;
  starting_balance?: string;
  /** Horizon's forward-only page token for the operations collection. */
  paging_token?: string;
}

export const NATIVE_DECIMALS = 7;

export function classicOpToRow(accountId: string, op: ClassicOp): HistoryTx | undefined {
  const asset = classicAssetOf(op);
  if (!asset) return undefined;

  let counterparty = "";
  let direction: HistoryDirection = "self";
  let amount = 0n;

  if (op.type === "payment" || op.type.startsWith("path_payment")) {
    if (!op.amount) return undefined;
    counterparty = op.from === accountId ? (op.to ?? "") : (op.from ?? "");
    direction = directionFor(accountId, op.from, op.to);
    amount = decimalToRaw(op.amount);
  } else if (op.type === "create_account") {
    if (!op.starting_balance) return undefined;
    counterparty = op.account ?? "";
    direction = op.from === accountId ? "out" : "in";
    amount = decimalToRaw(op.starting_balance);
  } else if (op.type === "account_merge") {
    counterparty = op.account ?? "";
    direction = op.from === accountId ? "out" : "in";
  } else {
    // Trustline changes, set_options, invoke_host_function, etc. are not
    // transfer-shaped and carry no amount to show.
    return undefined;
  }

  return {
    // Namespaced so a classic op can never collide with a Soroban event id.
    id: `classic:${op.id}`,
    kind: "classic",
    direction,
    counterparty,
    amount,
    asset,
    timestamp: op.created_at,
    // A failed classic tx is rolled back, so it is shown as an explicit
    // "failed" attempt rather than omitted — the user asked whether it went
    // through, and silence would be the wrong answer.
    status: op.transaction_successful ? "success" : "failed",
    txHash: op.transaction_hash,
  };
}

function classicAssetOf(op: ClassicOp): HistoryAsset | undefined {
  if (op.asset_type === "native") {
    return { kind: "classic", code: "XLM", decimals: NATIVE_DECIMALS, contractId: "" };
  }
  if (op.asset_code && op.asset_issuer) {
    return {
      kind: "classic",
      code: op.asset_code,
      decimals: NATIVE_DECIMALS,
      contractId: "",
      issuer: op.asset_issuer,
    };
  }
  return undefined;
}

/** "12.0000004" → 120000004n (Horizon decimal amounts are exact 7dp strings). */
export function decimalToRaw(decimal: string): bigint {
  const negative = decimal.startsWith("-");
  const unsigned = negative ? decimal.slice(1) : decimal;
  const [whole, frac = ""] = unsigned.split(".");
  const paddedFrac = frac.padEnd(NATIVE_DECIMALS, "0").slice(0, NATIVE_DECIMALS);
  const raw = BigInt(`${whole}${paddedFrac}` || "0");
  return negative ? -raw : raw;
}

function directionFor(
  accountId: string,
  from: string | undefined,
  to: string | undefined,
): HistoryDirection {
  const isFrom = from === accountId;
  const isTo = to === accountId;
  if (isFrom && !isTo) return "out";
  if (isTo && !isFrom) return "in";
  return "self";
}

// --- Merged pagination --------------------------------------------------------

export interface MergeInput {
  accountId: string;
  events: RawEvent[];
  ops: ClassicOp[];
  /** Resolved asset per contract id; unresolved ids drop their rows rather
   *  than render an amount without an asset (issue #403 hard requirement). */
  assetOf: (contractId: string) => HistoryAsset | undefined;
  pageSize: number;
  decoder: ScValDecoder;
}

// --- Per-rail paging ----------------------------------------------------------
//
// WHY NOT ONE MERGED SORT. The obvious shape — merge both rails, sort by
// timestamp, slice to pageSize — is subtly wrong, and the defect is invisible
// until it is read closely.
//
// getEvents returns events in ASCENDING order and its cursor walks FORWARD
// toward the chain head; there is no "latest N" mode and `order: "desc"` was
// verified to be ignored. So a forward cursor cannot serve a newest-first page
// from the tail of a stream without stranding everything before it. Worse,
// `ledgerClosedAt` does not always order events the way the stream does:
// verified live, a scanned window interleaved ledgers 920976 and 920988 such
// that the 920988 row sorted NEWEST while sitting at the END of the stream.
// Taking "the oldest emitted row by timestamp" as a resume point then skipped
// the rest of 920976 and re-read 920988 from its start — re-emitting a row the
// first page had already shown. That is exactly the "re-serving the same page"
// defect class, and it reproduced intermittently because it depends on where a
// ledger boundary happens to fall inside a scan.
//
// So each rail is paged on its own terms: the Soroban rail reverses its
// ascending stream (newest first) and never trims, because the caller resumes
// from the window's oldest ledger and would otherwise have no way to reach a
// trimmed row; the classic rail trims against Horizon's own newest-first
// cursor, which can express the resume point. Only the final display order is a
// timestamp sort.

export interface RailPage {
  /** Newest-first rows for this rail, at most `pageSize` of them. */
  rows: HistoryTx[];
  /** Cursor to resume this rail after; undefined when the rail is drained. */
  resume: string | undefined;
}

/**
 * Builds the Soroban rail for one page.
 *
 * `events` MUST be in the order getEvents returned them (ascending, oldest
 * first) and MUST cover a complete ledger window — that is what makes this
 * correct. The window's newest transfers are its LAST entries, so they are
 * rendered by reversing the stream. Nothing is trimmed off the end, because a
 * trimmed row would have no way to reach the next page: the cursor moves
 * backwards by ledger, so every transfer in the window is either shown now or
 * re-derived in the following window. `resume` is therefore never derived here;
 * the caller resumes from the window's oldest ledger.
 */
export function buildSorobanRail(input: {
  accountId: string;
  events: RawEvent[];
  assetOf: (contractId: string) => HistoryAsset | undefined;
  decoder: ScValDecoder;
}): HistoryTx[] {
  const rows: HistoryTx[] = [];
  for (const event of input.events) {
    if (!isSACTransferEvent(event, input.decoder)) continue;
    const asset = input.assetOf(contractIdOf(event));
    if (!asset) continue;
    const row = parseSACTransfer(input.accountId, event, asset, input.decoder);
    if (row) rows.push(row);
  }
  // Ascending stream → newest first.
  return rows.reverse();
}

/**
 * Pages the classic rail. Horizon is queried `order("desc")`, so `ops` arrives
 * newest-first and the resume point is the paging token of the last emitted
 * operation. Operations that are not payments are dropped, which is why the
 * token is taken from the last EMITTED row rather than the last record.
 */
export function buildClassicRail(input: {
  accountId: string;
  ops: ClassicOp[];
  pageSize: number;
}): RailPage {
  const rows: HistoryTx[] = [];
  for (const op of input.ops) {
    const row = classicOpToRow(input.accountId, op);
    if (row) rows.push(row);
  }
  if (rows.length <= input.pageSize) return { rows, resume: undefined };

  const last = rows[input.pageSize - 1];
  const lastOpId = last?.id.slice("classic:".length);
  const resume = input.ops.find((o) => String(o.id) === lastOpId)?.paging_token;
  return { rows: rows.slice(0, input.pageSize), resume };
} /**
 * Merges a page of rows from both rails into one newest-first list for display.
 * Paging itself is per-rail (buildSorobanRail / buildClassicRail); this is only
 * the ordering the UI renders.
 */
export function mergeHistoryPages(input: MergeInput): { rows: HistoryTx[]; pageHasMore: boolean } {
  const rows: HistoryTx[] = [];
  for (const event of input.events) {
    if (!isSACTransferEvent(event, input.decoder)) continue;
    const asset = input.assetOf(contractIdOf(event));
    if (!asset) continue;
    const row = parseSACTransfer(input.accountId, event, asset, input.decoder);
    if (row) rows.push(row);
  }
  for (const op of input.ops) {
    const row = classicOpToRow(input.accountId, op);
    if (row) rows.push(row);
  }
  // Date.parse rather than string compare: the two rails format timestamps
  // independently (Soroban `ledgerClosedAt`, Horizon `created_at`), and any
  // offset or precision difference would mis-order a string comparison.
  rows.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return { rows: rows.slice(0, input.pageSize), pageHasMore: rows.length > input.pageSize };
}

// --- Soroban contract invocation operations (#557) ----------------------------

export const UNKNOWN_OPERATION_FALLBACK = "Unknown operation";
export const UNRECOGNIZED_SOROBAN_INVOCATION_FALLBACK = "Soroban contract invocation";

export type SorobanHostFunctionType =
  "invoke_contract" | "create_contract" | "upload_wasm" | "unknown";

export interface SorobanBalanceChange {
  type?: string;
  from?: string;
  to?: string;
  amount: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
}

export interface SorobanInvocationParameter {
  type?: string;
  value?: unknown;
}

export interface SorobanInvocationOp {
  id?: string;
  type?: string;
  transaction_successful?: boolean;
  created_at?: string;
  transaction_hash?: string;
  function?: string;
  function_name?: string;
  contract_id?: string;
  contractId?: string;
  parameters?: SorobanInvocationParameter[];
  args?: unknown[];
  asset_balance_changes?: SorobanBalanceChange[];
}

export interface ParsedSorobanInvocation {
  id: string;
  txHash: string;
  timestamp: string;
  status: "success" | "failed";
  hostFunctionType: SorobanHostFunctionType;
  contractId?: string;
  functionName?: string;
  recognized: boolean;
  /** Human-readable description distinct from UNKNOWN_OPERATION_FALLBACK. */
  description: string;
  /** Populated when the invocation includes a resolvable balance transfer for `accountId`. */
  transferRow?: HistoryTx;
}

const SOROBAN_OP_TYPES = new Set(["invoke_host_function", "invokeHostFunction"]);

const HOST_FUNCTION_KIND_MAP: Record<string, SorobanHostFunctionType> = {
  HostFunctionTypeHostFunctionTypeInvokeContract: "invoke_contract",
  host_function_type_invoke_contract: "invoke_contract",
  invoke_contract: "invoke_contract",
  HostFunctionTypeHostFunctionTypeCreateContract: "create_contract",
  HostFunctionTypeHostFunctionTypeCreateContractV2: "create_contract",
  host_function_type_create_contract: "create_contract",
  create_contract: "create_contract",
  HostFunctionTypeHostFunctionTypeUploadContractWasm: "upload_wasm",
  host_function_type_upload_contract_wasm: "upload_wasm",
  upload_wasm: "upload_wasm",
};

const KNOWN_CONTRACT_METHOD_LABELS: Record<string, string> = {
  transfer: "Token transfer",
  approve: "Token approval",
  mint: "Token mint",
  burn: "Token burn",
  swap_exact_tokens_for_tokens: "Token swap",
  swap_tokens_for_exact_tokens: "Token swap",
  add_policy: "Attach policy signer",
  remove: "Remove signer",
};

function shortenContractId(contractId: string): string {
  const trimmed = contractId.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 5)}…${trimmed.slice(-4)}`;
}

function safeDecodeParam(param: unknown, decoder?: ScValDecoder): string | undefined {
  if (typeof param === "string" && param.trim().length > 0) {
    return param.trim();
  }
  if (typeof param === "object" && param !== null) {
    const record = param as Record<string, unknown>;
    if (decoder && "value" in record && record.value !== undefined) {
      try {
        const decoded = decoder(record.value);
        if (typeof decoded === "string" && decoded.trim().length > 0) {
          return decoded.trim();
        }
      } catch {
        // Ignore decoder failures and fall back to raw string inspection
      }
    }
    if (typeof record.value === "string" && record.value.trim().length > 0) {
      const raw = record.value.trim();
      // Filter out raw base64 XDR blobs unless short human symbol
      if (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(raw) && !raw.endsWith("=")) {
        return raw;
      }
    }
  }
  if (decoder && param !== undefined) {
    try {
      const decoded = decoder(param);
      if (typeof decoded === "string" && decoded.trim().length > 0) {
        return decoded.trim();
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Returns true when `op` is a Soroban `invoke_host_function` / `invokeHostFunction` operation. */
export function isSorobanInvocationOp(op: unknown): op is SorobanInvocationOp {
  if (typeof op !== "object" || op === null) return false;
  const type = (op as { type?: unknown }).type;
  return typeof type === "string" && SOROBAN_OP_TYPES.has(type);
}

/**
 * Parse a Soroban `invoke_host_function` operation into a structured summary
 * with a human-readable description distinct from `UNKNOWN_OPERATION_FALLBACK`.
 * Never throws; unrecognized or malformed invocations fall back gracefully.
 */
export function parseSorobanInvocationOp(
  op: unknown,
  options?: {
    accountId?: string;
    decoder?: ScValDecoder;
  },
): ParsedSorobanInvocation | undefined {
  try {
    if (!isSorobanInvocationOp(op)) return undefined;

    const id = typeof op.id === "string" && op.id ? op.id : "unknown";
    const txHash = typeof op.transaction_hash === "string" ? op.transaction_hash : "";
    const timestamp =
      typeof op.created_at === "string" && op.created_at
        ? op.created_at
        : new Date(0).toISOString();
    const status = op.transaction_successful === false ? "failed" : "success";

    const rawFnKind = typeof op.function === "string" ? op.function.trim() : "";
    let hostFunctionType: SorobanHostFunctionType = HOST_FUNCTION_KIND_MAP[rawFnKind] ?? "unknown";

    let contractId =
      typeof op.contract_id === "string" && op.contract_id.trim()
        ? op.contract_id.trim()
        : typeof op.contractId === "string" && op.contractId.trim()
          ? op.contractId.trim()
          : undefined;

    let functionName =
      typeof op.function_name === "string" && op.function_name.trim()
        ? op.function_name.trim()
        : undefined;

    // If `op.function` itself is a short method name (not a HostFunctionType enum), use it
    if (
      !functionName &&
      rawFnKind &&
      !(rawFnKind in HOST_FUNCTION_KIND_MAP) &&
      /^[a-z_][a-z0-9_]{0,63}$/.test(rawFnKind)
    ) {
      functionName = rawFnKind;
      hostFunctionType = "invoke_contract";
    }

    // Inspect Horizon `parameters` or `args` if contractId / functionName were not top-level
    const params = Array.isArray(op.parameters)
      ? op.parameters
      : Array.isArray(op.args)
        ? op.args
        : [];
    if (params.length > 0) {
      const p0 = safeDecodeParam(params[0], options?.decoder);
      const p1 = safeDecodeParam(params[1], options?.decoder);
      if (!contractId && p0 && /^C[A-Z2-7]{55}$/.test(p0)) {
        contractId = p0;
        if (!functionName && p1 && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(p1)) {
          functionName = p1;
        }
      } else if (!functionName && p0 && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(p0)) {
        functionName = p0;
      }
    }

    if ((contractId || functionName) && hostFunctionType === "unknown") {
      hostFunctionType = "invoke_contract";
    }

    let recognized = false;
    let description = UNRECOGNIZED_SOROBAN_INVOCATION_FALLBACK;

    if (hostFunctionType === "create_contract") {
      recognized = true;
      description = contractId
        ? `Soroban contract deployment (${shortenContractId(contractId)})`
        : "Soroban contract deployment";
    } else if (hostFunctionType === "upload_wasm") {
      recognized = true;
      description = "Soroban contract WASM upload";
    } else if (hostFunctionType === "invoke_contract" && (functionName || contractId)) {
      recognized = true;
      const friendlyLabel = functionName ? KNOWN_CONTRACT_METHOD_LABELS[functionName] : undefined;
      if (friendlyLabel && contractId) {
        description = `Soroban ${friendlyLabel.toLowerCase()} (${functionName} on ${shortenContractId(contractId)})`;
      } else if (functionName && contractId) {
        description = `Soroban contract call: ${functionName} on ${shortenContractId(contractId)}`;
      } else if (functionName) {
        description = `Soroban contract call: ${functionName}`;
      } else if (contractId) {
        description = `Soroban contract call on ${shortenContractId(contractId)}`;
      }
    }

    let transferRow: HistoryTx | undefined;
    if (options?.accountId && Array.isArray(op.asset_balance_changes)) {
      const change = op.asset_balance_changes.find(
        (c) => c && typeof c.amount === "string" && (c.from || c.to),
      );
      if (change) {
        const asset = classicAssetOf({
          id,
          type: "payment",
          transaction_successful: status === "success",
          created_at: timestamp,
          transaction_hash: txHash,
          asset_type: change.asset_type ?? "native",
          asset_code: change.asset_code,
          asset_issuer: change.asset_issuer,
        });
        if (asset) {
          transferRow = {
            id: `soroban:op:${id}`,
            kind: "soroban",
            direction: directionFor(options.accountId, change.from, change.to),
            counterparty:
              change.from === options.accountId ? (change.to ?? "") : (change.from ?? ""),
            amount: decimalToRaw(change.amount),
            asset: {
              ...asset,
              kind: "soroban",
              contractId: contractId ?? "",
            },
            timestamp,
            status,
            txHash,
          };
        }
      }
    }

    return {
      id: `soroban:op:${id}`,
      txHash,
      timestamp,
      status,
      hostFunctionType,
      ...(contractId !== undefined && { contractId }),
      ...(functionName !== undefined && { functionName }),
      recognized,
      description,
      ...(transferRow !== undefined && { transferRow }),
    };
  } catch {
    return {
      id: "soroban:op:unknown",
      txHash: "",
      timestamp: new Date(0).toISOString(),
      status: "failed",
      hostFunctionType: "unknown",
      recognized: false,
      description: UNRECOGNIZED_SOROBAN_INVOCATION_FALLBACK,
    };
  }
}

/**
 * Produce a human-readable description for a history operation. Soroban
 * `invoke_host_function` operations return a Soroban-specific description
 * distinct from `UNKNOWN_OPERATION_FALLBACK`. Never throws.
 */
export function describeHistoryOperation(
  op: unknown,
  options?: { decoder?: ScValDecoder },
): string {
  try {
    if (isSorobanInvocationOp(op)) {
      return (
        parseSorobanInvocationOp(op, options)?.description ??
        UNRECOGNIZED_SOROBAN_INVOCATION_FALLBACK
      );
    }
    if (typeof op !== "object" || op === null) return UNKNOWN_OPERATION_FALLBACK;
    const type = (op as { type?: unknown }).type;
    if (typeof type !== "string") return UNKNOWN_OPERATION_FALLBACK;
    if (type === "payment" || type.startsWith("path_payment")) return "Classic payment";
    if (type === "create_account") return "Account creation";
    if (type === "account_merge") return "Account merge";
    return UNKNOWN_OPERATION_FALLBACK;
  } catch {
    return UNKNOWN_OPERATION_FALLBACK;
  }
}
