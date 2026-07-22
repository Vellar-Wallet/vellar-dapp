import type { FastifyBaseLogger, FastifyInstance } from "fastify";

// Shared bootstrap for services/* (technical-doc.md §6.3). Keeps health
// checks and process lifecycle identical across services without copy-paste.

export {
  registerMetrics,
  metricsRegistry,
  domainMetrics,
  recordOutcome,
  __resetMetricsForTest,
  type Outcome,
} from "./metrics";

export function registerHealth(app: FastifyInstance, serviceName: string): void {
  app.get("/health", async () => ({ status: "ok", service: serviceName }));
}

/**
 * Structured domain-event log (idea.md §13 Logging): one consistent shape for
 * the events the spec calls out (auth, tx lifecycle, policy, verification,
 * cleanup). A single helper means every service logs `event` + context the same
 * way, so log-based queries and dashboards are uniform. This complements the
 * durable `activity_logs` audit trail — logs are for operational search, the
 * audit table is the record of truth.
 */
export function logEvent(
  log: Pick<FastifyBaseLogger, "info">,
  event: string,
  context: Record<string, unknown> = {},
): void {
  log.info({ event, ...context }, event);
}

/**
 * Attempt a database connection, degrading gracefully instead of crashing the
 * whole service when the DB is unreachable (e.g. Postgres not started yet).
 *
 * On success returns the connect thunk's handle. On failure it logs a single
 * actionable line — pointing at the compose command that starts the local DB —
 * and returns `undefined`, signalling the caller to fall back to its in-memory
 * repositories. A missing DB during local dev must not produce a raw
 * ECONNREFUSED stack trace or a crash loop.
 */
export interface WarnLogger {
  warn(message: string): void;
}

export async function tryConnectDb<T>(
  connect: () => Promise<T>,
  options: { databaseUrl: string; log: WarnLogger },
): Promise<T | undefined> {
  try {
    return await connect();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    options.log.warn(
      `Could not connect to Postgres at ${redactDbUrl(options.databaseUrl)} (${reason}). ` +
        "Falling back to IN-MEMORY storage — data will NOT survive a restart. " +
        "Start the local database with: docker compose -f infra/docker/docker-compose.yml up -d",
    );
    return undefined;
  }
}

/** Strip credentials from a Postgres URL so it is safe to log. */
export function redactDbUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    if (url.password) url.password = "***";
    if (url.username) url.username = "***";
    return url.toString();
  } catch {
    return "the configured database";
  }
}

export interface StartOptions {
  port: number;
  host?: string;
}

/**
 * Start a Fastify app with graceful shutdown on SIGINT/SIGTERM.
 * Exits the process on startup failure — services must not run half-alive.
 */
export async function startService(app: FastifyInstance, options: StartOptions): Promise<void> {
  const host = options.host ?? "0.0.0.0";

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ port: options.port, host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

export function portFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${name} must be a valid port number, got "${raw}"`);
  }
  return port;
}
