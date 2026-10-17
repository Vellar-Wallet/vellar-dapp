import {
  createVerificationClient,
  type VerificationClient,
  type VerificationStatus,
  type VerificationStatusResult,
} from "@vellar/verification-sdk";
import type { TransactionSummary } from "./tx-summary";

// Extension binding for the verification API. The gateway URL is a build-time
// env (WXT inlines import.meta.env); it defaults to the public gateway so the
// trust badge works out of the box. The extension only ever READS verification
// status here (the cheap /status lookup) — submissions happen in the web app.

const DEFAULT_API = "https://api.vellar.xyz";

export type ApprovalTrustState = "verified" | "no_record" | "explicit_unverified" | "pending";

export interface ApprovalTrustSignal {
  contractId: string;
  state: ApprovalTrustState;
  status: VerificationStatus;
  recordId?: string;
  updatedAt?: string;
  label: string;
  detail: string;
  tone: "verified" | "neutral" | "warning" | "pending";
}

export function verificationApiUrl(): string {
  // WXT exposes vars prefixed WXT_PUBLIC_* to the client bundle.
  const fromEnv =
    typeof import.meta !== "undefined"
      ? (import.meta.env?.WXT_PUBLIC_API_URL as string | undefined)
      : undefined;
  return fromEnv || DEFAULT_API;
}

export function verificationClient(fetchImpl?: typeof fetch): VerificationClient {
  return createVerificationClient({ apiUrl: verificationApiUrl(), fetch: fetchImpl });
}

/**
 * Classifies a raw `/verification/:contractId/status` response into a
 * structured approval-screen trust signal that distinguishes:
 * - `verified`: contract has a verified build record matching on-chain WASM
 * - `no_record`: contract has no verification record on file (`unverified` without `recordId`)
 * - `explicit_unverified`: contract has a record that failed verification or was explicitly marked unverified
 * - `pending`: verification build is currently queued or running
 */
export function resolveApprovalTrustSignal(result: VerificationStatusResult): ApprovalTrustSignal {
  const base = {
    contractId: result.contractId,
    status: result.status,
    ...(result.recordId !== undefined ? { recordId: result.recordId } : {}),
    ...(result.updatedAt !== undefined ? { updatedAt: result.updatedAt } : {}),
  };

  if (result.status === "verified") {
    return {
      ...base,
      state: "verified",
      label: "Verified contract",
      detail: "On-chain WASM matches the reproducibly built source record.",
      tone: "verified",
    };
  }

  if (result.status === "submitted" || result.status === "building") {
    return {
      ...base,
      state: "pending",
      label: "Verification in progress",
      detail: "Source verification has been submitted and is currently building.",
      tone: "pending",
    };
  }

  if (result.status === "failed" || (result.status === "unverified" && Boolean(result.recordId))) {
    return {
      ...base,
      state: "explicit_unverified",
      label: "Explicitly unverified",
      detail:
        "A verification record exists for this contract, but verification failed or did not match.",
      tone: "warning",
    };
  }

  return {
    ...base,
    state: "no_record",
    label: "No verification record",
    detail: "No source verification record has been published for this contract.",
    tone: "neutral",
  };
}

/**
 * Fetches and resolves the approval trust signal for `contractId`.
 * Degrades gracefully to `no_record` if the verification gateway is unreachable.
 */
export async function fetchApprovalTrustSignal(
  contractId: string,
  client: Pick<VerificationClient, "getStatus"> = verificationClient(),
): Promise<ApprovalTrustSignal> {
  try {
    const result = await client.getStatus(contractId);
    return resolveApprovalTrustSignal(result);
  } catch {
    return resolveApprovalTrustSignal({
      contractId,
      status: "unverified",
    });
  }
}

/**
 * Extracts unique contract IDs referenced by a transaction summary so the
 * approval screen can surface contract verification trust signals prominently.
 */
export function extractApprovalContractIds(
  summary: TransactionSummary | null | undefined,
): string[] {
  if (!summary) return [];
  const seen = new Set<string>();
  for (const op of summary.operations) {
    if (op.kind === "contract-call" && op.contract) {
      seen.add(op.contract);
    }
  }
  return [...seen];
}
