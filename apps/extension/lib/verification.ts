import { createVerificationClient, type VerificationStatusResult } from "@vellar/verification-sdk";
import type { TrustBadgeStatus } from "@vellar/ui";

// Extension binding for the verification API. The gateway URL is a build-time
// env (WXT inlines import.meta.env); it defaults to the public gateway so the
// trust badge works out of the box. The extension only ever READS verification
// status here (the cheap /status lookup) — submissions happen in the web app.

const DEFAULT_API = "https://api.vellar.xyz";

export function verificationApiUrl(): string {
  // WXT exposes vars prefixed WXT_PUBLIC_* to the client bundle.
  const fromEnv =
    typeof import.meta !== "undefined"
      ? (import.meta.env?.WXT_PUBLIC_API_URL as string | undefined)
      : undefined;
  return fromEnv || DEFAULT_API;
}

export function verificationClient() {
  return createVerificationClient({ apiUrl: verificationApiUrl() });
}

/**
 * Classify a trust lookup for the approval-screen badge (#583). The API's
 * `status: "unverified"` is ambiguous on its own — it means EITHER "no one has
 * ever submitted this contract" OR, in principle, a contract whose only
 * records are non-terminal/failed — so the badge must not treat every
 * "unverified" result as a confident negative signal reflecting a lookup
 * that actually ran. We use `recordId` (only ever set when a real
 * verification record exists, per the API contract — see
 * packages/verification-sdk) to tell "no record at all" apart from a result
 * that is explicitly `unverified` with a record behind it. Both render with
 * the same neutral tone today (`trustSignal` has no separate case), but they
 * are distinct `TrustBadgeStatus` values so a caller — or a future design —
 * can treat them differently without re-deriving this from the raw API
 * payload at every call site.
 */
export function classifyContractTrust(
  result: VerificationStatusResult | undefined,
  lookupFailed: boolean,
): TrustBadgeStatus {
  if (lookupFailed) return "error";
  if (!result) return "loading";
  if (result.status === "unverified" && result.recordId === undefined) return "no_record";
  return result.status;
}
