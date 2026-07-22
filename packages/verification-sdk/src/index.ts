import type { VerificationRecord, VerificationStatus } from "@vela/types";

// @vela/verification-sdk — the shared client for the verification API
// (idea.md §11), used by BOTH the web app (submission + explorer) and the
// extension (trust-badge status lookup). Keeping the calling logic here means
// the two surfaces never duplicate it — the trust-signal contract is defined
// once (technical-doc.md §5.5). `fetch` is injectable so it works in the
// browser, the extension background worker, and tests.

export type { VerificationRecord, VerificationStatus };

/** A public verification record as returned by the API (build log included). */
export interface PublicVerificationRecord extends VerificationRecord {
  log?: string;
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

export interface VerificationClientOptions {
  /** Gateway base URL (e.g. https://api.vellar.xyz). */
  apiUrl: string;
  /** Injected fetch; defaults to global fetch. */
  fetch?: typeof fetch;
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

  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}/verification${path}`, {
        headers: init?.body ? { "content-type": "application/json" } : undefined,
        ...init,
      });
    } catch (err) {
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
    case "submitted":
    case "building":
      return { label: "Verification in progress", tone: "pending" };
    case "unverified":
    default:
      return { label: "Unverified", tone: "neutral" };
  }
}
