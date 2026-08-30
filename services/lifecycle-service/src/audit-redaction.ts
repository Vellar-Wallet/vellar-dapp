import crypto from "crypto";

/**
 * Audit log event before redaction.
 * Raw data from endpoints may contain PII.
 */
export interface AuditEvent {
  type: string;
  at: string;
  data: Record<string, unknown>;
}

/**
 * Generates a redaction salt for consistent hashing across the service lifetime.
 * The salt is deterministic per service instance and never changes for that instance,
 * ensuring that the same input always produces the same hash (enabling correlation).
 *
 * In production, the salt should be:
 * - Generated once at service startup
 * - Stored (e.g., in memory or a secure config store)
 * - Never logged or exported
 *
 * The salt is NOT cryptographically sensitive (it's not a secret key); it's used to
 * ensure deterministic hashing for correlation without exposing raw PII.
 */
export function generateRedactionSalt(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Hashes a value deterministically for PII redaction.
 * Always produces the same output for the same input (within a service instance).
 *
 * @param value - The raw value to hash (e.g., Stellar account ID)
 * @param salt - The redaction salt (service-level, constant)
 * @returns SHA256 hash truncated to 12 hex characters (48 bits)
 */
export function hashForRedaction(value: string, salt: string): string {
  const combined = value + salt;
  const hash = crypto.createHash("sha256").update(combined).digest("hex");
  return hash.substring(0, 12);
}

/**
 * Extracts blocker types from a CleanupPlan's blockers array.
 * Used to preserve operational utility (what kinds of blockers exist)
 * while dropping descriptions that contain PII.
 *
 * @param blockers - Array of blocker objects with a 'type' field
 * @returns Array of unique blocker types
 */
function extractBlockerTypes(blockers: unknown[]): string[] {
  if (!Array.isArray(blockers)) return [];
  const types = new Set<string>();
  for (const blocker of blockers) {
    if (typeof blocker === "object" && blocker !== null && "type" in blocker) {
      const type = (blocker as Record<string, unknown>).type;
      if (typeof type === "string") types.add(type);
    }
  }
  return Array.from(types).sort();
}

/**
 * Redacts PII from a lifecycle-service audit event before persistence.
 *
 * Redaction strategy:
 * - DROP: Raw PII fields (account IDs, data keys, descriptions, XDR)
 * - HASH: Sensitive fields needed for correlation (accounts, destinations)
 * - KEEP: Operational non-PII fields (counts, types, hashes)
 *
 * The same input always produces the same redacted output (deterministic hashing),
 * enabling correlation across audit entries without exposing raw PII.
 *
 * @param event - The audit event before redaction
 * @param salt - The redaction salt (should be constant per service instance)
 * @returns Redacted audit event safe for persistence and external shipment
 */
export function redactAuditEvent(event: AuditEvent, salt: string): AuditEvent {
  const redacted: AuditEvent = {
    type: event.type,
    at: event.at,
    data: {},
  };

  // Helper to safely access and redact plan objects
  function redactPlan(plan: unknown): Record<string, unknown> {
    if (typeof plan !== "object" || plan === null) return {};

    const p = plan as Record<string, unknown>;
    const redactedPlan: Record<string, unknown> = {};

    // Hash account identifiers for correlation
    if (typeof p.accountId === "string") {
      redactedPlan.accountRef = hashForRedaction(p.accountId, salt);
    }
    if (typeof p.destination === "string") {
      redactedPlan.destinationRef = hashForRedaction(p.destination, salt);
    }

    // Preserve operational fields
    if (typeof p.estimatedTransactions === "number") {
      redactedPlan.estimatedTransactions = p.estimatedTransactions;
    }
    if (typeof p.mergeReady === "boolean") {
      redactedPlan.mergeReady = p.mergeReady;
    }

    // Extract blocker types (preserve operational value, drop descriptions)
    if (Array.isArray(p.blockers)) {
      const blockerTypes = extractBlockerTypes(p.blockers);
      redactedPlan.blockerTypes = blockerTypes;
      redactedPlan.blockerCount = p.blockers.length;
    }

    // DROP: account object (full HorizonAccount)
    // DROP: blockers[].description
    // DROP: blockers[].actionRequired
    // DROP: dataKeys array

    return redactedPlan;
  }

  // Helper to safely redact a single step (transaction)
  function redactStep(step: unknown): Record<string, unknown> {
    if (typeof step !== "object" || step === null) return {};

    const s = step as Record<string, unknown>;
    const redactedStep: Record<string, unknown> = {};

    // Preserve non-PII fields
    if (typeof s.title === "string") {
      redactedStep.title = s.title;
    }
    if (typeof s.hash === "string") {
      redactedStep.hash = s.hash;
    }

    // DROP: xdr (full transaction envelope with account IDs)
    // DROP: description (contains raw account IDs)

    return redactedStep;
  }

  // Redact based on endpoint type
  const eventType = event.type;

  if (eventType === "lifecycle.inspect_requested" || eventType === "lifecycle.account_inspected") {
    // POST /lifecycle/inspect returns { account: HorizonAccount }
    // DROP the entire account object
    // No fields to preserve
  } else if (eventType === "lifecycle.plan_requested" || eventType === "lifecycle.cleanup_planned") {
    // POST /lifecycle/plan returns { plan: CleanupPlan }
    if (event.data.plan) {
      redacted.data.plan = redactPlan(event.data.plan);
    }
  } else if (eventType === "lifecycle.execute_requested" || eventType === "lifecycle.cleanup_executed") {
    // POST /lifecycle/execute returns { steps: CleanupStep[], plan: CleanupPlan }
    if (event.data.plan) {
      redacted.data.plan = redactPlan(event.data.plan);
    }
    if (Array.isArray(event.data.steps)) {
      redacted.data.steps = (event.data.steps as unknown[]).map((step) => redactStep(step));
    }
  } else if (eventType === "lifecycle.merge_requested" || eventType === "lifecycle.account_merged") {
    // POST /lifecycle/merge returns { step: CleanupStep }
    if (event.data.step) {
      redacted.data.step = redactStep(event.data.step);
    }
  } else {
    // Unknown event type: apply conservative redaction
    // Only preserve top-level primitive fields that are unlikely to contain PII
    for (const [key, value] of Object.entries(event.data)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null
      ) {
        // Avoid common PII field names
        if (
          !["accountId", "destination", "account", "dataKeys", "offers", "description"].includes(
            key,
          )
        ) {
          redacted.data[key] = value;
        }
      }
    }
  }

  return redacted;
}
