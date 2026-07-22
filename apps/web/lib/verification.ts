import {
  createVerificationClient,
  type PublicVerificationRecord,
  type SubmitVerificationInput,
  type VerificationStatusResult,
} from "@vela/verification-sdk";
import { walletConfig } from "./config";

// Web-app binding for the verification API (idea.md §11): builds the shared
// verification-sdk client against the configured gateway. The web app and the
// extension both use @vela/verification-sdk — the calling logic isn't
// duplicated (technical-doc.md §5.5).

export type { PublicVerificationRecord, SubmitVerificationInput, VerificationStatusResult };

function client() {
  return createVerificationClient({ apiUrl: walletConfig().apiUrl });
}

export function submitVerification(
  input: SubmitVerificationInput,
): Promise<PublicVerificationRecord> {
  return client().submit(input);
}

export function getVerificationHistory(contractId: string): Promise<PublicVerificationRecord[]> {
  return client().getHistory(contractId);
}

export function getVerificationStatus(contractId: string): Promise<VerificationStatusResult> {
  return client().getStatus(contractId);
}

/** Client-side guard so a malformed id never reaches the API. */
export function isContractId(value: string): boolean {
  return /^C[A-Z2-7]{55}$/.test(value.trim());
}
