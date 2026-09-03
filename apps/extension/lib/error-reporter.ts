/**
 * Error reporting service integration for the extension background worker (#302).
 * Captures uncaught and operational errors in the background worker and forwards
 * them to the centralized reporting endpoint along with extension version and browser metadata.
 */

export interface ErrorReportContext {
  extensionVersion: string;
  browserInfo: string;
  userAgent?: string;
  url?: string;
  [key: string]: unknown;
}

export interface ErrorReportPayload {
  message: string;
  name: string;
  stack?: string;
  context: ErrorReportContext;
  timestamp: string;
}

export interface ErrorReportClient {
  send(payload: ErrorReportPayload): Promise<void>;
}

/** Default in-memory/console error reporting client fallback. */
export class DefaultErrorReportClient implements ErrorReportClient {
  private readonly reports: ErrorReportPayload[] = [];

  async send(payload: ErrorReportPayload): Promise<void> {
    this.reports.push(payload);
    console.error("[vellar-error-reporter]", payload.name, payload.message, payload.context);
  }

  getReports(): ErrorReportPayload[] {
    return [...this.reports];
  }
}

export interface ErrorReporterOptions {
  extensionVersion?: string;
  browserInfo?: string;
  client?: ErrorReportClient;
}

export class ErrorReporter {
  private readonly extensionVersion: string;
  private readonly browserInfo: string;
  private readonly client: ErrorReportClient;

  constructor(options: ErrorReporterOptions = {}) {
    this.extensionVersion =
      options.extensionVersion ??
      (typeof process !== "undefined" && process.env?.WXT_PUBLIC_VERSION
        ? process.env.WXT_PUBLIC_VERSION
        : "0.1.0");
    this.browserInfo =
      options.browserInfo ??
      (typeof navigator !== "undefined" ? navigator.userAgent : "BackgroundWorker/VellarExtension");
    this.client = options.client ?? new DefaultErrorReportClient();
  }

  async reportError(
    error: unknown,
    additionalContext: Record<string, unknown> = {},
  ): Promise<ErrorReportPayload> {
    const errObj = error instanceof Error ? error : new Error(String(error ?? "Unknown Error"));
    const payload: ErrorReportPayload = {
      name: errObj.name || "Error",
      message: errObj.message || "An unknown error occurred",
      stack: errObj.stack,
      context: {
        extensionVersion: this.extensionVersion,
        browserInfo: this.browserInfo,
        ...additionalContext,
      },
      timestamp: new Date().toISOString(),
    };

    try {
      await this.client.send(payload);
    } catch (sendErr) {
      console.error("Failed to deliver error report payload", sendErr);
    }

    return payload;
  }
}

/** Global background worker error reporter instance */
export const backgroundErrorReporter = new ErrorReporter();
