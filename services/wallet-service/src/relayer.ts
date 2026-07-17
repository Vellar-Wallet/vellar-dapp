// Fee-sponsored transaction submission seam (docs/decisions.md: OpenZeppelin
// Relayer via passkey-kit's PasskeyServer; the API key lives only in this
// service's environment, never in the browser).

export class SubmissionError extends Error {
  readonly code: string;

  constructor(message: string, code = "submission_failed") {
    super(message);
    this.name = "SubmissionError";
    this.code = code;
  }
}

export interface TransactionSubmitter {
  /** Submits a signed transaction; resolves with its hash or rejects with SubmissionError. */
  submit(signedXdr: string): Promise<{ hash: string }>;
}

/** Used when relayer env config is absent (local dev without a key) — fails loudly, never silently. */
export function createUnconfiguredSubmitter(): TransactionSubmitter {
  return {
    async submit() {
      throw new SubmissionError(
        "Relayer is not configured. Set RELAYER_BASE_URL and RELAYER_API_KEY (see .env.example).",
        "relayer_not_configured",
      );
    },
  };
}

// Structural view of PasskeyServer.send's result (passkey-kit v0.13).
export interface PasskeyServerLike {
  send(signedXdr: string): Promise<
    | { success: true; hash: string }
    | {
        success: false;
        error: {
          code: string;
          message: string;
          /** PasskeyKitError structured context (diagnostics), when present. */
          context?: Record<string, unknown>;
        };
      }
  >;
}

export function createRelayerSubmitter(server: PasskeyServerLike): TransactionSubmitter {
  return {
    async submit(signedXdr) {
      const result = await server.send(signedXdr);
      if (!result.success) {
        // Keep the relayer's structured diagnostics — "Simulation failed"
        // alone is undebuggable.
        const context = result.error.context ? ` ${JSON.stringify(result.error.context)}` : "";
        throw new SubmissionError(`${result.error.message}${context}`, result.error.code);
      }
      return { hash: result.hash };
    },
  };
}
