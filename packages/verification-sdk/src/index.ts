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

export class VerificationApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "VerificationApiError";
    this.status = status;
    this.code = code;
  }
}

/** Client-side request timeout — the network-level request was aborted
 * before any response arrived. Distinct from a server-reported
 * build-timeout (which arrives as a `VerificationApiError`). */
export class ClientTimeoutError extends Error {
  readonly code = "client_timeout";
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms (no response from server)`);
    this.name = "ClientTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export interface VerificationClientOptions {
  /** Gateway base URL (e.g. https://api.vellar.xyz). */
  apiUrl: string;
  /** Injected fetch; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Client-side request timeout in ms. When the network request hangs
   * with no response, abort and throw `ClientTimeoutError`. Default: 30 000. */
  timeoutMs?: number;
}

export interface VerificationClient {
  /** POST /verification/submit — queue a contract for verification. */
  submit(input: SubmitVerificationInput): Promise<PublicVerificationRecord>;
  /** GET /verification/:contractId — the full verification history. */
  getHistory(contractId: string): Promise<PublicVerificationRecord[]>;
  /** GET /verification/:contractId/status — the trust-signal status. */
  getStatus(contractId: string): Promise<VerificationStatusResult>;
}

export function createVerificationClient(options: VerificationClientOptions): VerificationClient {
  const base = options.apiUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let timedOut = false;
    const onTimeout = () => {
      timedOut = true;
    };
    controller.signal.addEventListener("abort", onTimeout);

    let res: Response;
    try {
      res = await doFetch(`${base}/verification${path}`, {
        headers: init?.body ? { "content-type": "application/json" } : undefined,
        signal: controller.signal,
        ...init,
      });
    } catch (err) {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onTimeout);
      if (timedOut) throw new ClientTimeoutError(timeoutMs);
      // Network/CORS failure — surface as a typed error, not a raw TypeError.
      throw new VerificationApiError(
        err instanceof Error ? err.message : "network request failed",
        0,
      );
    }
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onTimeout);
    const payload = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    } & T;
    if (!res.ok) {
      throw new VerificationApiError(
        payload.message ?? payload.error ?? `Request failed (${res.status})`,
        res.status,
        payload.error,
      );
    }
    return payload;
  }

  return {
    async submit(input) {
      const { record } = await req<{ record: PublicVerificationRecord }>("/submit", {
        method: "POST",
        body: JSON.stringify(input),
      });
      return record;
    },
    async getHistory(contractId) {
      const { records } = await req<{ records: PublicVerificationRecord[] }>(
        `/${encodeURIComponent(contractId)}`,
      );
      return records;
    },
    async getStatus(contractId) {
      return req<VerificationStatusResult>(`/${encodeURIComponent(contractId)}/status`);
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
    case "dead_letter":
      // A job reclaimed and re-run VERIFY_MAX_ATTEMPTS times without
      // reaching a terminal state (see VerificationStatus's doc comment).
      // This attempt genuinely failed, repeatedly, not merely "never
      // submitted." Previously fell through to the unverified/neutral
      // default below, misrepresenting a confirmed failure as an unchecked
      // contract (#587).
      return { label: "Verification failed", tone: "warning" };
    case "submitted":
    case "building":
      return { label: "Verification in progress", tone: "pending" };
    case "unverified":
    default:
      return { label: "Unverified", tone: "neutral" };
  }
}
