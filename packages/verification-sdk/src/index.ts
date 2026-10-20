import type { VerificationRecord, VerificationStatus } from "@vellar/types";

// @vellar/verification-sdk — the shared client for the verification API
// (idea.md §11), used by BOTH the web app (submission + explorer) and the
// extension (trust-badge status lookup). Keeping the calling logic here means
// the two surfaces never duplicate it — the trust-signal contract is defined
// once (technical-doc.md §5.5). `fetch` is injectable so it works in the
// browser, the extension background worker, and tests.

export type { VerificationRecord, VerificationStatus };

/** A public verification record as returned by the API. The raw build log is
 * NOT exposed (H3/FIX 6 — it leaked host paths / internal IPs); the API returns
 * a sanitized `statusDetail` instead. */
export interface PublicVerificationRecord extends VerificationRecord {
  /** Sanitized, public-safe failure/status detail (e.g. "Build failed (clone_failed)."). */
  statusDetail?: string;
}

/** The cheap trust-signal lookup used by the badge. */
export interface VerificationStatusResult {
  contractId: string;
  status: VerificationStatus;
  recordId?: string;
  updatedAt?: string;
}

/** Inputs for a verification submission (idea.md §6.3). */
export interface SubmitVerificationInput {
  contractId: string;
  sourceType: "repo" | "upload";
  repoUrl?: string;
  commitHash?: string;
  sourceArchiveRef?: string;
  toolchainVersion: string;
  buildFlags?: string[];
  lockfileHash?: string;
}

export const DEFAULT_VERIFICATION_CLIENT_TIMEOUT_MS = 10_000;

export class VerificationApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly timeoutKind?: "client_request_timeout" | "server_build_timeout";

  constructor(
    message: string,
    status: number,
    code?: string,
    timeoutKind?: "client_request_timeout" | "server_build_timeout",
  ) {
    super(message);
    this.name = "VerificationApiError";
    this.status = status;
    this.code = code;
    this.timeoutKind = timeoutKind;
  }
}

/**
 * Thrown when an HTTP request from `@vellar/verification-sdk` exceeds the
 * configured client-side `timeoutMs` without receiving a response. Distinct
 * from a server-reported build timeout (`code: "build_timeout"` / `"BUILD_TIMEOUT"`).
 */
export class VerificationClientTimeoutError extends VerificationApiError {
  override readonly code = "CLIENT_TIMEOUT" as const;
  override readonly timeoutKind = "client_request_timeout" as const;
  readonly timeoutMs: number;
  readonly path: string;

  constructor(path: string, timeoutMs: number) {
    super(
      `Verification client request timed out after ${timeoutMs}ms waiting for ${path}`,
      0,
      "CLIENT_TIMEOUT",
      "client_request_timeout",
    );
    this.name = "VerificationClientTimeoutError";
    this.timeoutMs = timeoutMs;
    this.path = path;
  }
}

export function isClientTimeoutError(err: unknown): err is VerificationClientTimeoutError {
  return (
    err instanceof VerificationClientTimeoutError ||
    (err instanceof VerificationApiError &&
      err.code === "CLIENT_TIMEOUT" &&
      err.timeoutKind === "client_request_timeout")
  );
}

export function isServerBuildTimeoutError(err: unknown): boolean {
  if (!(err instanceof VerificationApiError) || isClientTimeoutError(err)) {
    return false;
  }
  const normalizedCode = (err.code ?? "").toLowerCase();
  return (
    err.timeoutKind === "server_build_timeout" ||
    normalizedCode === "build_timeout" ||
    normalizedCode === "server_build_timeout"
  );
}

export interface VerificationRequestOptions {
  /** Per-request client-side timeout in milliseconds (overrides client default). */
  timeoutMs?: number;
  /** Optional external AbortSignal to cancel the request. */
  signal?: AbortSignal;
}

export interface VerificationClientOptions {
  /** Gateway base URL (e.g. https://api.vellar.xyz). */
  apiUrl: string;
  /** Injected fetch; defaults to global fetch. */
  fetch?: typeof fetch;
  /**
   * Client-side HTTP request timeout in milliseconds (default: 10,000 ms).
   * Independent of the server-side verification build timeout so hung network
   * requests fail fast for the caller.
   */
  timeoutMs?: number;
}

export interface VerificationClient {
  /** POST /verification/submit — queue a contract for verification. */
  submit(
    input: SubmitVerificationInput,
    requestOptions?: VerificationRequestOptions,
  ): Promise<PublicVerificationRecord>;
  /** GET /verification/:contractId — the full verification history. */
  getHistory(
    contractId: string,
    requestOptions?: VerificationRequestOptions,
  ): Promise<PublicVerificationRecord[]>;
  /** GET /verification/:contractId/status — the trust-signal status. */
  getStatus(
    contractId: string,
    requestOptions?: VerificationRequestOptions,
  ): Promise<VerificationStatusResult>;
}

export function createVerificationClient(options: VerificationClientOptions): VerificationClient {
  const base = options.apiUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_VERIFICATION_CLIENT_TIMEOUT_MS;

  if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
    throw new RangeError("VerificationClient timeoutMs must be a positive number");
  }

  async function req<T>(
    path: string,
    init?: RequestInit,
    requestOptions?: VerificationRequestOptions,
  ): Promise<T> {
    const effectiveTimeoutMs = requestOptions?.timeoutMs ?? defaultTimeoutMs;
    if (!Number.isFinite(effectiveTimeoutMs) || effectiveTimeoutMs <= 0) {
      throw new RangeError("Verification request timeoutMs must be a positive number");
    }

    const controller = new AbortController();
    let timedOut = false;
    let timerId: ReturnType<typeof setTimeout> | undefined;

    const externalSignal = requestOptions?.signal;
    const onExternalAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort(externalSignal.reason);
      } else {
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new VerificationClientTimeoutError(path, effectiveTimeoutMs));
      }, effectiveTimeoutMs);
    });

    try {
      const fetchPromise = (async () => {
        let res: Response;
        try {
          res = await doFetch(`${base}/verification${path}`, {
            headers: init?.body ? { "content-type": "application/json" } : undefined,
            ...init,
            signal: controller.signal,
          });
        } catch (err) {
          if (timedOut) {
            throw new VerificationClientTimeoutError(path, effectiveTimeoutMs);
          }
          // Network/CORS failure — surface as a typed error, not a raw TypeError.
          throw new VerificationApiError(
            err instanceof Error ? err.message : "network request failed",
            0,
          );
        }
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        } & T;
        if (!res.ok) {
          const errorCode = payload.error;
          const isBuildTimeout =
            typeof errorCode === "string" &&
            (errorCode.toLowerCase() === "build_timeout" ||
              errorCode.toLowerCase() === "server_build_timeout");
          throw new VerificationApiError(
            payload.message ?? payload.error ?? `Request failed (${res.status})`,
            res.status,
            errorCode,
            isBuildTimeout ? "server_build_timeout" : undefined,
          );
        }
        return payload;
      })();

      return await Promise.race([fetchPromise, timeoutPromise]);
    } finally {
      if (timerId !== undefined) clearTimeout(timerId);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  return {
    async submit(input, requestOptions) {
      const { record } = await req<{ record: PublicVerificationRecord }>(
        "/submit",
        {
          method: "POST",
          body: JSON.stringify(input),
        },
        requestOptions,
      );
      return record;
    },
    async getHistory(contractId, requestOptions) {
      const { records } = await req<{ records: PublicVerificationRecord[] }>(
        `/${encodeURIComponent(contractId)}`,
        undefined,
        requestOptions,
      );
      return records;
    },
    async getStatus(contractId, requestOptions) {
      return req<VerificationStatusResult>(
        `/${encodeURIComponent(contractId)}/status`,
        undefined,
        requestOptions,
      );
    },
  };
}

/** UI helper: a human trust label + severity for a status, so web and extension
 * render the badge consistently (§5.5). */
export function trustSignal(status: VerificationStatus): {
  label: string;
  tone: "verified" | "warning" | "neutral" | "pending";
} {
  switch (status) {
    case "verified":
      return { label: "Verified source", tone: "verified" };
    case "failed":
      return { label: "Verification failed", tone: "warning" };
    case "submitted":
    case "building":
      return { label: "Verification in progress", tone: "pending" };
    case "unverified":
    default:
      return { label: "Unverified", tone: "neutral" };
  }
}
