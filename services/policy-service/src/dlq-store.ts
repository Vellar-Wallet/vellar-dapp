/**
 * Dead-Letter Queue (DLQ) persistence layer for policy deployment jobs.
 * 
 * Stores policy deployment jobs that have exceeded maxRetries, with immutable
 * audit trails and support for admin requeue operations.
 * 
 * Key invariants:
 * - DLQ entries are immutable except for admin metadata (requeue_count, archived, requeue_in_progress)
 * - Each entry has a tamper-resistant audit trail (timestamps, actor, tx id)
 * - Requeueing creates a new job with reset retry counter; original DLQ record remains
 * - All transitions are logged with non-sensitive metadata for diagnostics
 */

export interface DLQRecord {
  id: string; // UUID
  original_job_id: string; // UUID of the failed job
  policy_id: string; // UUID of the policy being deployed
  job_type: "policy_deploy"; // Discriminator for future queue types
  payload: unknown; // The original job payload (policy deploy args)
  last_error: string; // Summarized error (PII redacted)
  failure_count: number; // Total number of failures before moving to DLQ
  first_failed_at: string; // ISO timestamp
  last_failed_at: string; // ISO timestamp
  archived: boolean; // Soft-delete flag (admin can mark for retention/purge)
  requeue_count: number; // How many times this DLQ entry has been requeued
  requeue_in_progress: boolean; // Flag to prevent concurrent requeue operations
  last_requeued_at?: string; // ISO timestamp of last requeue
  last_requeued_by?: string; // Admin user id (for audit trail)
  created_at: string; // ISO timestamp
  updated_at: string; // ISO timestamp
}

export interface AuditEvent {
  id: string; // UUID
  dlq_id: string; // Reference to DLQ record
  event_type: "dlq_move" | "dlq_requeue" | "dlq_requeue_failed" | "dlq_archived";
  actor?: string; // User id for admin actions
  metadata: Record<string, unknown>; // Non-sensitive context (original_job_id, new_job_id, reason, etc)
  created_at: string; // ISO timestamp
}

export interface DLQStore {
  /**
   * Insert a new DLQ entry atomically (called when job exceeds maxRetries).
   * Must be called within a transaction to ensure atomicity with job status update.
   */
  insert(record: Omit<DLQRecord, "id" | "created_at" | "updated_at">): Promise<DLQRecord>;

  /**
   * Find a DLQ entry by id. Returns undefined if not found or archived.
   */
  find(id: string, options?: { includeArchived?: boolean }): Promise<DLQRecord | undefined>;

  /**
   * List DLQ entries with pagination and optional filtering.
   */
  list(options?: {
    jobType?: string;
    limit?: number;
    offset?: number;
    includeArchived?: boolean;
  }): Promise<{ entries: DLQRecord[]; total: number }>;

  /**
   * Get the current DLQ depth (count of non-archived entries).
   */
  depth(): Promise<number>;

  /**
   * Update a DLQ entry (used for requeue_count, archived flag, in-progress flag).
   * Only specific fields can be updated; payload and error details are immutable.
   */
  update(
    id: string,
    updates: Partial<Pick<DLQRecord, "requeue_count" | "archived" | "requeue_in_progress" | "last_requeued_at" | "last_requeued_by" | "updated_at">>,
  ): Promise<void>;

  /**
   * Record an audit event for DLQ operations.
   */
  recordAudit(event: Omit<AuditEvent, "id" | "created_at">): Promise<AuditEvent>;

  /**
   * Get audit trail for a DLQ entry.
   */
  getAuditTrail(dlqId: string, limit?: number): Promise<AuditEvent[]>;
}

/**
 * In-memory DLQ store for testing and development.
 */
export function createMemoryDLQStore(): DLQStore {
  const records = new Map<string, DLQRecord>();
  const auditLog: AuditEvent[] = [];

  function generateId(): string {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  }

  return {
    async insert(record) {
      const id = generateId();
      const now = new Date().toISOString();
      const dlqRecord: DLQRecord = {
        id,
        ...record,
        requeue_count: 0,
        requeue_in_progress: false,
        archived: false,
        created_at: now,
        updated_at: now,
      };
      records.set(id, dlqRecord);
      return dlqRecord;
    },

    async find(id, options) {
      const record = records.get(id);
      if (!record) return undefined;
      if (record.archived && !options?.includeArchived) return undefined;
      return record;
    },

    async list(options) {
      let entries = Array.from(records.values());
      
      if (options?.jobType) {
        entries = entries.filter((e) => e.job_type === options.jobType);
      }
      
      if (!options?.includeArchived) {
        entries = entries.filter((e) => !e.archived);
      }
      
      const total = entries.length;
      
      if (options?.offset) {
        entries = entries.slice(options.offset);
      }
      
      if (options?.limit) {
        entries = entries.slice(0, options.limit);
      }
      
      return { entries, total };
    },

    async depth() {
      return Array.from(records.values()).filter((e) => !e.archived).length;
    },

    async update(id, updates) {
      const record = records.get(id);
      if (!record) throw new Error(`DLQ entry not found: ${id}`);
      
      const now = new Date().toISOString();
      Object.assign(record, updates, { updated_at: now });
    },

    async recordAudit(event) {
      const id = generateId();
      const now = new Date().toISOString();
      const auditEvent: AuditEvent = {
        id,
        ...event,
        created_at: now,
      };
      auditLog.push(auditEvent);
      return auditEvent;
    },

    async getAuditTrail(dlqId, limit = 50) {
      return auditLog
        .filter((e) => e.dlq_id === dlqId)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, limit);
    },
  };
}

/**
 * Utility to summarize errors for DLQ storage (redacts PII).
 */
export function summarizeError(error: unknown, maxLength = 200): string {
  let message = "";
  
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  } else {
    message = String(error);
  }
  
  // Redact common PII patterns
  message = message
    .replace(/0x[a-fA-F0-9]{40,}/g, "0x[address]")
    .replace(/C[A-Z2-7]{55}/g, "[contract]")
    .replace(/G[A-Z2-7]{55}/g, "[account]")
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "[ip]")
    .replace(/:[0-9a-f]{32,64}/gi, ":[key]");
  
  if (message.length > maxLength) {
    message = message.substring(0, maxLength - 3) + "...";
  }
  
  return message;
}
