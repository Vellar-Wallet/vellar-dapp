import { createVerificationClient } from "@vela/verification-sdk";

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
