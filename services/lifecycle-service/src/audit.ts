import { redactAuditEvent, generateRedactionSalt, type AuditEvent } from "./audit-redaction";

/**
 * AuditLog interface for lifecycle-service audit trail.
 * Events are automatically redacted before persistence to remove PII.
 */
export interface AuditLog {
  /**
   * Records an audit event.
   * The event is automatically redacted before persistence.
   *
   * @param type - Event type (e.g., "lifecycle.cleanup_planned")
   * @param data - Event data (may contain PII — will be redacted)
   */
  record(type: string, data: Record<string, unknown>): Promise<void>;

  /**
   * Lists all recorded audit events (already redacted).
   * @returns Array of redacted audit events ordered by timestamp
   */
  list(): Promise<AuditEvent[]>;
}

/**
 * In-memory audit log implementation (for development/testing).
 * Events are stored in a list and redacted on record.
 *
 * @param redactionSalt - Salt for deterministic hashing (should be constant per service instance)
 * @returns AuditLog implementation
 */
export function createMemoryAuditLog(redactionSalt: string): AuditLog {
  const events: AuditEvent[] = [];

  return {
    async record(type, data) {
      const event: AuditEvent = {
        type,
        at: new Date().toISOString(),
        data,
      };
      const redacted = redactAuditEvent(event, redactionSalt);
      events.push(redacted);
    },

    async list() {
      return [...events];
    },
  };
}

/**
 * No-op audit log implementation (disables audit logging).
 * Useful for testing endpoints without audit side effects.
 *
 * @returns AuditLog implementation that does nothing
 */
export function createNoOpAuditLog(): AuditLog {
  return {
    async record() {
      // No-op
    },

    async list() {
      return [];
    },
  };
}

/**
 * Initializes the redaction salt and creates an audit log.
 * This function should be called once at service startup to ensure
 * consistent hashing across the service lifetime.
 *
 * @param implementation - Which implementation to use ("memory" or "noop")
 * @returns Tuple of [redactionSalt, auditLog]
 */
export function initializeAuditLog(implementation: "memory" | "noop" = "memory"): [string, AuditLog] {
  const salt = generateRedactionSalt();
  const auditLog =
    implementation === "memory" ? createMemoryAuditLog(salt) : createNoOpAuditLog();
  return [salt, auditLog];
}
