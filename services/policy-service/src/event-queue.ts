import { randomUUID } from "node:crypto";
import { domainMetrics, recordOutcome } from "@vellar/service-kit";

/**
 * Message in the policy-service event queue.
 */
export interface PolicyEventMessage<T = unknown> {
  id: string;
  eventType: string;
  payload: T;
  attempts: number;
  maxAttempts?: number;
  enqueuedAt: string;
  correlationId?: string;
}

/**
 * Record of a poisoned message isolated in the quarantine queue.
 */
export interface QuarantinedMessage<T = unknown> {
  message: PolicyEventMessage<T>;
  quarantinedAt: string;
  attempts: number;
  reason: string;
  stack?: string;
}

export interface QuarantineQueue<T = unknown> {
  quarantine(msg: PolicyEventMessage<T>, reason: string, stack?: string): Promise<void>;
  list(): Promise<QuarantinedMessage<T>[]>;
  get(id: string): Promise<QuarantinedMessage<T> | undefined>;
  count(): Promise<number>;
}

export function createMemoryQuarantineQueue<T = unknown>(): QuarantineQueue<T> {
  const records = new Map<string, QuarantinedMessage<T>>();
  return {
    async quarantine(msg, reason, stack) {
      records.set(msg.id, {
        message: msg,
        quarantinedAt: new Date().toISOString(),
        attempts: msg.attempts,
        reason,
        stack,
      });
    },
    async list() {
      return [...records.values()];
    },
    async get(id) {
      return records.get(id);
    },
    async count() {
      return records.size;
    },
  };
}

export interface ConsumerOptions {
  /** Maximum times a message may fail processing before being quarantined as poison. Default 3. */
  maxAttempts?: number;
  /** Custom logger for alerting and operational telemetry. */
  log?: {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
  };
  /** Alerting callback invoked when a poison message is moved to quarantine. */
  onQuarantine?: (quarantined: QuarantinedMessage) => void;
}

export type ProcessOutcome = "success" | "retry" | "quarantined";

export interface ProcessResult {
  messageId: string;
  outcome: ProcessOutcome;
  attempts: number;
  reason?: string;
}

/**
 * PolicyEventQueueConsumer with automatic poison-message detection, quarantine isolation,
 * and ops alerting (Issue #297).
 */
export class PolicyEventQueue<T = unknown> {
  private queue: PolicyEventMessage<T>[] = [];
  private quarantineQueue: QuarantineQueue<T>;
  private maxAttempts: number;
  private log: NonNullable<ConsumerOptions["log"]>;
  private onQuarantine?: ConsumerOptions["onQuarantine"];

  constructor(options: ConsumerOptions = {}, quarantineQueue?: QuarantineQueue<T>) {
    const envAttempts = Number(process.env.POLICY_EVENT_MAX_ATTEMPTS);
    this.maxAttempts =
      options.maxAttempts ?? (Number.isFinite(envAttempts) && envAttempts > 0 ? envAttempts : 3);
    this.quarantineQueue = quarantineQueue ?? createMemoryQuarantineQueue<T>();
    this.log = options.log ?? {
      info: (msg, ...args) => console.log(`[policy-event-queue] ${msg}`, ...args),
      warn: (msg, ...args) => console.warn(`[policy-event-queue] ${msg}`, ...args),
      error: (msg, ...args) => console.error(`[policy-event-queue] ${msg}`, ...args),
    };
    this.onQuarantine = options.onQuarantine;
  }

  /**
   * Enqueue a new event message.
   */
  async enqueue(
    event: {
      eventType: string;
      payload: T;
      id?: string;
      maxAttempts?: number;
      correlationId?: string;
    },
  ): Promise<PolicyEventMessage<T>> {
    const msg: PolicyEventMessage<T> = {
      id: event.id ?? randomUUID(),
      eventType: event.eventType,
      payload: event.payload,
      attempts: 0,
      maxAttempts: event.maxAttempts ?? this.maxAttempts,
      enqueuedAt: new Date().toISOString(),
      correlationId: event.correlationId,
    };
    this.queue.push(msg);
    return msg;
  }

  /**
   * Number of pending messages in the active queue.
   */
  pendingCount(): number {
    return this.queue.length;
  }

  /**
   * Access the quarantine queue.
   */
  getQuarantine(): QuarantineQueue<T> {
    return this.quarantineQueue;
  }

  /**
   * Processes the next message from the queue with poison-message detection and quarantine.
   */
  async processNext(
    handler: (message: PolicyEventMessage<T>) => Promise<void>,
  ): Promise<ProcessResult | undefined> {
    const msg = this.queue.shift();
    if (!msg) return undefined;

    msg.attempts += 1;
    const limit = msg.maxAttempts ?? this.maxAttempts;

    try {
      // Validate basic message envelope structure
      if (!msg.eventType || msg.payload === undefined) {
        throw new Error("Malformed message: missing eventType or payload");
      }

      await handler(msg);
      return {
        messageId: msg.id,
        outcome: "success",
        attempts: msg.attempts,
      };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;

      if (msg.attempts >= limit) {
        // Poison message threshold reached — quarantine immediately and alert
        await this.quarantineQueue.quarantine(msg, reason, stack);

        // Alert 1: Log alert with ALERT tag
        this.log.error(
          `[ALERT] Poison message quarantined: id=${msg.id}, eventType=${msg.eventType}, attempts=${msg.attempts}/${limit}, reason=${reason}`,
        );

        // Alert 2: Prometheus counter increment (follows standardized metrics naming convention)
        recordOutcome(domainMetrics.policyPoisonMessages, "policy-service", "failure");

        // Alert 3: External alert callback hook
        if (this.onQuarantine) {
          const quarantined = await this.quarantineQueue.get(msg.id);
          if (quarantined) {
            try {
              this.onQuarantine(quarantined);
            } catch (alertErr) {
              this.log.error("Failed to execute onQuarantine alert callback", alertErr);
            }
          }
        }

        return {
          messageId: msg.id,
          outcome: "quarantined",
          attempts: msg.attempts,
          reason,
        };
      } else {
        // Message failed but has remaining retries — re-queue to retry later
        this.log.warn(
          `Message ${msg.id} failed processing (attempt ${msg.attempts}/${limit}): ${reason}. Re-queueing.`,
        );
        this.queue.push(msg);
        return {
          messageId: msg.id,
          outcome: "retry",
          attempts: msg.attempts,
          reason,
        };
      }
    }
  }

  /**
   * Drains and processes all currently pending messages in the queue.
   */
  async processAll(
    handler: (message: PolicyEventMessage<T>) => Promise<void>,
  ): Promise<ProcessResult[]> {
    const results: ProcessResult[] = [];
    while (this.queue.length > 0) {
      const res = await this.processNext(handler);
      if (res) results.push(res);
    }
    return results;
  }
}
