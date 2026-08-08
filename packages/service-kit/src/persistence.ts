// Persistence boot policy (security-audit.md M6 / FIX 7).
//
// The old behavior silently degraded to in-memory repositories whenever
// DATABASE_URL was unset OR Postgres was unreachable, and /health still
// reported "ok" — so a misconfigured production instance served traffic on
// volatile state (audit log, session list, and — since FIX 1/FIX 3 — the
// funding-path scoping and spend budgets all depend on durable state).
//
// This makes the decision explicit and FAIL-CLOSED in production: a prod
// instance either runs on Postgres or refuses to boot, unless the operator
// explicitly opts into in-memory with ALLOW_INMEMORY=1.

export interface PersistenceInputs {
  /** process.env.DATABASE_URL (undefined when unset). */
  databaseUrl: string | undefined;
  /** process.env.NODE_ENV. */
  nodeEnv: string | undefined;
  /** Whether a connection attempt succeeded. Omit when no attempt was made
   * (i.e. databaseUrl is unset). */
  connected?: boolean;
  /** process.env.ALLOW_INMEMORY === "1" — explicit operator opt-in to run
   * stateless even in production. */
  allowInmemory?: boolean;
}

export type PersistenceDecision =
  | { action: "use-postgres" }
  | { action: "allow-inmemory" }
  | { action: "fail"; reason: string };

const isProduction = (nodeEnv: string | undefined) => nodeEnv === "production";

/** Decide how a service should handle its persistence at boot. Pure so the
 * fail-closed logic is unit-tested without spinning a real DB. */
export function resolvePersistencePolicy(inputs: PersistenceInputs): PersistenceDecision {
  const { databaseUrl, nodeEnv, connected, allowInmemory } = inputs;

  // Explicit opt-in always wins: an operator who sets ALLOW_INMEMORY=1 has
  // accepted volatile state (e.g. an ephemeral demo).
  if (allowInmemory) return { action: "allow-inmemory" };

  if (!databaseUrl) {
    if (isProduction(nodeEnv)) {
      return {
        action: "fail",
        reason:
          "DATABASE_URL is not set in production. Refusing to run on in-memory storage " +
          "(set DATABASE_URL, or ALLOW_INMEMORY=1 to explicitly accept volatile state).",
      };
    }
    return { action: "allow-inmemory" };
  }

  // DATABASE_URL is set. If the connection succeeded, use it.
  if (connected) return { action: "use-postgres" };

  // Set but unreachable.
  if (isProduction(nodeEnv)) {
    return {
      action: "fail",
      reason:
        "DATABASE_URL is set but Postgres is unreachable in production. Refusing to degrade " +
        "to in-memory storage (fail-closed). Fix the database or set ALLOW_INMEMORY=1.",
    };
  }
  return { action: "allow-inmemory" };
}
