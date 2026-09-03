/**
 * Secrets redactor for worker-service logging.
 *
 * Prevents accidental exposure of secrets in log output by redacting:
 * - DATABASE_URL (Postgres connection string with credentials)
 * - ATTESTOR_SECRET_KEY (Ed25519 private key)
 * - RPC URLs with embedded credentials (if any)
 *
 * Used before all error logging to filter error objects and stack traces.
 * Non-blocking: if redaction fails, original value is logged (fail-open for observability).
 */

const SECRET_ENV_VARS = [
  "DATABASE_URL",
  "ATTESTOR_SECRET_KEY",
  "API_KEY",
  "SECRET_KEY",
  "PRIVATE_KEY",
  "PASSWORD",
];

/**
 * Redacts a value from log output. Replaces exact matches of secret values.
 * Called before logging to prevent credentials from appearing in error messages.
 */
export function redact(obj: unknown): unknown {
  try {
    if (typeof obj === "string") {
      return redactString(obj);
    }

    if (obj instanceof Error) {
      // Redact error message and stack
      return {
        name: obj.name,
        message: redactString(obj.message),
        stack: redactString(obj.stack ?? ""),
        cause: obj.cause ? redact(obj.cause) : undefined,
      };
    }

    if (obj && typeof obj === "object" && !(obj instanceof Date)) {
      // Recursively redact object properties
      if (Array.isArray(obj)) {
        return obj.map((item) => redact(item));
      }

      return Object.fromEntries(
        Object.entries(obj as Record<string, unknown>).map(([key, value]) => {
          // Check if this key represents a secret variable
          const isSecretKey = SECRET_ENV_VARS.some((secretVar) =>
            key.toLowerCase().includes(secretVar.toLowerCase())
          );

          if (isSecretKey) {
            return [key, "[REDACTED]"];
          }

          // Recursively redact nested values
          return [key, redact(value)];
        })
      );
    }

    return obj;
  } catch {
    // If redaction fails, return original (fail-open for logging)
    return obj;
  }
}

/**
 * Redacts known secret values from a string.
 * Replaces literal secret values with [REDACTED].
 */
export function redactString(input: unknown): string {
  if (typeof input !== "string") {
    return String(input);
  }

  let result = input;

  // Redact each secret environment variable value if it appears literally in the string
  for (const varName of SECRET_ENV_VARS) {
    const value = process.env[varName];
    if (value && value.length > 4) {
      // Only redact reasonably-long values to avoid false positives
      // Use replaceAll to catch all occurrences
      result = result.split(value).join("[REDACTED]");
    }
  }

  // Redact common secret patterns
  // PostgreSQL connection strings: postgresql://user:password@host/db
  result = result.replace(/postgresql:\/\/[^@]+@/gi, "postgresql://[REDACTED]@");

  // Generic connection strings with credentials: protocol://user:password@host
  result = result.replace(/([a-z]+:\/\/)[^:\/]+:[^@]+@/gi, "$1[REDACTED]@");

  // Ed25519 private keys (start with SA for Stellar)
  result = result.replace(/SA[A-Z2-7]{55}/gi, "[REDACTED]");

  // Generic "password=value" patterns
  result = result.replace(/password\s*=\s*[^\s;,]+/gi, "password=[REDACTED]");

  // "secret=value" patterns
  result = result.replace(/secret\s*=\s*[^\s;,]+/gi, "secret=[REDACTED]");

  // API key patterns
  result = result.replace(/api[_-]?key\s*=\s*[^\s;,]+/gi, "api_key=[REDACTED]");

  return result;
}

/**
 * Safe logger that redacts secrets before logging.
 * Wraps console logging to filter error objects and messages.
 */
export function safeLog(
  level: "info" | "warn" | "error" | "debug",
  message: string,
  data?: unknown
): void {
  const method = level as keyof typeof console;
  if (typeof console[method] !== "function") {
    return;
  }

  // Redact both the message and any attached data
  const safeMessage = redactString(message);
  const safeData = data !== undefined ? redact(data) : undefined;

  if (safeData === undefined) {
    console[method](safeMessage);
  } else {
    console[method](safeMessage, safeData);
  }
}

/**
 * Create a safe logger object with all methods pre-configured to redact.
 */
export function createSafeLogger(): {
  info: (msg: string, data?: unknown) => void;
  warn: (msg: string, data?: unknown) => void;
  error: (msg: string, data?: unknown) => void;
  debug: (msg: string, data?: unknown) => void;
} {
  return {
    info: (msg: string, data?: unknown) => safeLog("info", msg, data),
    warn: (msg: string, data?: unknown) => safeLog("warn", msg, data),
    error: (msg: string, data?: unknown) => safeLog("error", msg, data),
    debug: (msg: string, data?: unknown) => safeLog("debug", msg, data),
  };
}
