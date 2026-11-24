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

export class CircuitBreakerOpenError extends SubmissionError {
  constructor(message = "Circuit breaker open: RPC outage detected") {
    super(message, "circuit_breaker_open");
    this.name = "CircuitBreakerOpenError";
  }
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
}

export class CircuitBreaker {
  private failureCount = 0;
  private state: "CLOSED" | "OPEN" | "HALF_OPEN" = "CLOSED";
  private nextAttemptTime = 0;
  private readonly threshold: number;
  private readonly resetTimeoutMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30000;
  }

  canExecute(): boolean {
    if (this.state === "OPEN") {
      if (Date.now() >= this.nextAttemptTime) {
        this.state = "HALF_OPEN";
        return true;
      }
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this.state = "CLOSED";
  }

  recordFailure(): void {
    this.failureCount++;
    if (this.failureCount >= this.threshold) {
      this.state = "OPEN";
      this.nextAttemptTime = Date.now() + this.resetTimeoutMs;
    }
  }

  getState(): "CLOSED" | "OPEN" | "HALF_OPEN" {
    return this.state;
  }

  getFailureCount(): number {
    return this.failureCount;
  }

  reset(): void {
    this.failureCount = 0;
    this.state = "CLOSED";
    this.nextAttemptTime = 0;
  }
}

export interface RelayerSubmitterOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  circuitBreakerOptions?: CircuitBreakerOptions;
  circuitBreaker?: CircuitBreaker;
  sleepFn?: (ms: number) => Promise<void>;
}

export function calculateBackoffWithJitter(
  attempt: number,
  initialDelayMs = 100,
  maxDelayMs = 3000,
  backoffFactor = 2,
): number {
  const expDelay = initialDelayMs * Math.pow(backoffFactor, attempt);
  const cappedDelay = Math.min(expDelay, maxDelayMs);
  const jitter = Math.random() * 0.5 * cappedDelay;
  return Math.floor(cappedDelay + jitter);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createRelayerSubmitter(
  server: PasskeyServerLike,
  options: RelayerSubmitterOptions = {},
): TransactionSubmitter {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 3000;
  const backoffFactor = options.backoffFactor ?? 2;
  const sleep = options.sleepFn ?? defaultSleep;
  const circuitBreaker =
    options.circuitBreaker ?? new CircuitBreaker(options.circuitBreakerOptions);

  return {
    async submit(signedXdr) {
      if (!circuitBreaker.canExecute()) {
        throw new CircuitBreakerOpenError();
      }

      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const result = await server.send(signedXdr);
          if (!result.success) {
            // #824: a relayer can return HTTP 200 with a body shaped like an
            // error but missing the structured `error` object entirely (a
            // real-world API inconsistency) — payload inspection (`!result.success`)
            // still classifies it as a failure, but must not then throw an
            // unhandled TypeError reading into a missing `error` field.
            const error = result.error as { code?: string; message?: string; context?: Record<string, unknown> } | undefined;
            const context = error?.context ? ` ${JSON.stringify(error.context)}` : "";
            const err = new SubmissionError(
              `${error?.message ?? "Relayer reported failure without a structured error payload"}${context}`,
              error?.code ?? "submission_failed",
            );
            circuitBreaker.recordFailure();
            lastError = err;
          } else {
            circuitBreaker.recordSuccess();
            return { hash: result.hash };
          }
        } catch (err) {
          circuitBreaker.recordFailure();
          lastError = err;
        }

        if (attempt < maxRetries && circuitBreaker.canExecute()) {
          const delay = calculateBackoffWithJitter(
            attempt,
            initialDelayMs,
            maxDelayMs,
            backoffFactor,
          );
          await sleep(delay);
        } else {
          break;
        }
      }

      if (lastError instanceof Error) {
        throw lastError;
      }
      throw new SubmissionError("Transaction submission failed after retries", "submission_failed");
    },
  };
}
