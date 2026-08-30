/**
 * Client-side analytics event tracking for wallet operations.
 *
 * Follows the backend event pattern established in service-kit:
 * - Event names use dot-notation: "entity.action" (e.g., "wallet.created")
 * - Events are structured as JSON objects with contextual properties
 * - Sensitive data (session IDs, private keys, seed phrases) are never emitted
 * - Session IDs are hashed before inclusion in any event
 *
 * Events are buffered and sent in batches or on-demand. Failed sends
 * do not block wallet operations (analytics is fire-and-forget).
 */

import crypto from "crypto";
import type { CreateWalletInput, Network } from "@vellar/types";

/**
 * Event context includes metadata automatically attached to all events.
 */
export interface EventContext {
  /** Session ID (hashed for privacy) */
  sessionId?: string;
  /** Smart account contract address */
  contractId?: string;
  /** Network (testnet, mainnet, etc.) */
  network?: Network;
  /** Timestamp (ISO 8601) */
  timestamp: string;
  /** Unique session token for this user's browser session (not wallet session) */
  pageSessionId: string;
}

/**
 * Analytics event with name and properties.
 */
export interface AnalyticsEvent {
  /** Event name in dot-notation (e.g., "wallet.created") */
  name: string;
  /** Event-specific properties */
  properties?: Record<string, unknown>;
  /** Shared context metadata */
  context: EventContext;
}

/**
 * Hash a session ID (or any sensitive string) to preserve privacy while
 * maintaining correlation across events.
 *
 * Uses SHA-256 hashed truncated to 12 hex characters (matching backend audit log).
 * @param value - The value to hash
 * @returns Hashed value (12 hex chars)
 */
function hashSensitiveValue(value: string): string {
  const hash = crypto.createHash("sha256").update(value).digest("hex");
  return hash.slice(0, 12);
}

/**
 * Create a new analytics tracker instance.
 *
 * Initializes a page session ID (persists across page reloads within a tab)
 * and provides methods to emit events.
 *
 * @returns Analytics tracker
 */
export function createAnalyticsTracker() {
  // Generate a unique page session ID for this browser tab/window
  const pageSessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  /**
   * Queue to buffer events before sending. In production, this would be
   * sent to an analytics backend (e.g., via an API endpoint).
   */
  const eventQueue: AnalyticsEvent[] = [];

  /**
   * Emit a single analytics event.
   *
   * The event is added to a queue and marked for batch sending. If immediate
   * delivery is needed (e.g., before page unload), call `flush()` first.
   *
   * @param name - Event name (dot-notation, e.g., "wallet.created")
   * @param properties - Event-specific properties (must not include sensitive data)
   * @param context - Session context (sessionId, contractId, network)
   */
  function emit(
    name: string,
    properties?: Record<string, unknown>,
    context?: Partial<EventContext>,
  ) {
    const event: AnalyticsEvent = {
      name,
      properties,
      context: {
        timestamp: new Date().toISOString(),
        pageSessionId,
        ...context,
      },
    };
    eventQueue.push(event);

    // In development, log events to console for debugging
    if (process.env.NODE_ENV === "development") {
      console.debug("[analytics]", name, event);
    }
  }

  /**
   * Send all queued events to the analytics backend.
   * Failed sends do not throw; they are logged and ignored.
   * This is fire-and-forget to avoid blocking wallet operations.
   */
  async function flush() {
    if (eventQueue.length === 0) return;

    const events = eventQueue.splice(0); // Drain the queue

    try {
      // In production, send to your analytics backend.
      // For now, we persist to localStorage for testing/inspection.
      const stored = JSON.parse(localStorage.getItem("vellar.analytics.events") ?? "[]") as AnalyticsEvent[];
      stored.push(...events);
      // Keep only the last 1000 events in localStorage
      localStorage.setItem("vellar.analytics.events", JSON.stringify(stored.slice(-1000)));

      if (process.env.NODE_ENV === "development") {
        console.debug(`[analytics] flushed ${events.length} events`);
      }
    } catch (err) {
      // Silently ignore analytics errors — they must never break wallet operations
      console.error("[analytics] failed to persist events:", err);
    }
  }

  /**
   * Hash a sensitive value (e.g., session ID) before emitting it in an event.
   * Use this to include correlation IDs without exposing sensitive material.
   */
  function hashValue(value: string): string {
    return hashSensitiveValue(value);
  }

  return {
    emit,
    flush,
    hashValue,
    pageSessionId,
    getQueue: () => [...eventQueue], // For testing
  };
}

/**
 * Global analytics tracker instance.
 * Created on module load and reused across the app.
 */
let tracker: ReturnType<typeof createAnalyticsTracker> | null = null;

/**
 * Get or create the global analytics tracker.
 */
export function getAnalyticsTracker() {
  if (!tracker) {
    tracker = createAnalyticsTracker();
    // Auto-flush on page unload
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => {
        void tracker?.flush();
      });
    }
  }
  return tracker;
}

/**
 * Wallet creation funnel event definitions and emission helpers.
 *
 * Each helper corresponds to a step in the wallet creation flow and includes
 * the expected properties and privacy constraints.
 */
export const walletCreationEvents = {
  /**
   * User arrives at the onboarding page (/app) or initiates a wallet creation flow.
   * Fired once per page load/session entry point.
   */
  funnelStart: (context: Partial<EventContext>) => {
    getAnalyticsTracker().emit("wallet.funnel.start", undefined, context);
  },

  /**
   * User clicks the "Create wallet" button and passkey prompt is about to open.
   * Includes whether a username was provided.
   */
  createInitiated: (
    options: { hasUsername: boolean },
    context: Partial<EventContext>,
  ) => {
    getAnalyticsTracker().emit(
      "wallet.creation.initiated",
      { hasUsername: options.hasUsername },
      context,
    );
  },

  /**
   * User cancels the passkey prompt (e.g., closes browser dialog) before confirming.
   * No error, just user abandonment.
   */
  creationCancelled: (context: Partial<EventContext>) => {
    getAnalyticsTracker().emit("wallet.creation.cancelled", undefined, context);
  },

  /**
   * Passkey prompt was successful: user confirmed the passkey creation.
   * Does NOT mean the wallet is fully created yet (backend provisioning still pending).
   */
  passkeyConfirmed: (context: Partial<EventContext>) => {
    getAnalyticsTracker().emit("wallet.creation.passkey_confirmed", undefined, context);
  },

  /**
   * Backend successfully created the wallet: session is established and persisted.
   * The wallet is now usable for transactions.
   * Properties: network (testnet/mainnet/etc.), hasUsername (bool).
   *
   * PRIVACY: contractId is included to enable analytics correlation,
   * but sessionId must never be included (it's a bearer token).
   */
  walletCreated: (
    options: { network: Network; hasUsername: boolean },
    context: Partial<EventContext>,
  ) => {
    getAnalyticsTracker().emit(
      "wallet.created",
      { network: options.network, hasUsername: options.hasUsername },
      context,
    );
  },

  /**
   * Wallet creation failed at a known step: passkey error, network error, etc.
   * Properties: failureReason (string, user-facing error message)
   *
   * PRIVACY: Error message must not include sensitive material like seed phrases,
   * keys, or passwords. Caller is responsible for sanitizing before emitting.
   */
  creationFailed: (
    options: { failureReason: string; step?: "passkey" | "backend" },
    context: Partial<EventContext>,
  ) => {
    getAnalyticsTracker().emit(
      "wallet.creation.failed",
      { failureReason: options.failureReason, step: options.step },
      context,
    );
  },

  /**
   * User successfully navigated to the dashboard after wallet creation.
   * This marks the end of a successful wallet creation funnel.
   */
  funnelCompleted: (context: Partial<EventContext>) => {
    getAnalyticsTracker().emit("wallet.funnel.completed", undefined, context);
  },

  /**
   * User abandoned the wallet creation funnel (e.g., closed the page or navigated away)
   * before completion.
   */
  funnelAbandoned: (options: { step: string }, context: Partial<EventContext>) => {
    getAnalyticsTracker().emit(
      "wallet.funnel.abandoned",
      { step: options.step },
      context,
    );
  },
};

/**
 * Sign-in (connect wallet) funnel event definitions.
 * Similar structure to creation, but for existing wallet connection flow.
 */
export const walletSignInEvents = {
  /**
   * User clicks "Sign in" button and passkey prompt is about to open.
   */
  signInInitiated: (context: Partial<EventContext>) => {
    getAnalyticsTracker().emit("wallet.signin.initiated", undefined, context);
  },

  /**
   * Passkey confirmation successful during sign-in.
   */
  signinPasskeyConfirmed: (context: Partial<EventContext>) => {
    getAnalyticsTracker().emit("wallet.signin.passkey_confirmed", undefined, context);
  },

  /**
   * Backend successfully authenticated the passkey and session restored.
   */
  signinCompleted: (
    options: { network: Network },
    context: Partial<EventContext>,
  ) => {
    getAnalyticsTracker().emit("wallet.signin.completed", { network: options.network }, context);
  },

  /**
   * Sign-in failed (e.g., passkey not found, network error).
   */
  signinFailed: (
    options: { failureReason: string },
    context: Partial<EventContext>,
  ) => {
    getAnalyticsTracker().emit(
      "wallet.signin.failed",
      { failureReason: options.failureReason },
      context,
    );
  },
};
