import { errorPayload, type ProviderRequest, type ResponsePayload } from "@vellar/provider-sdk";
import type { PendingApprovalSummary } from "./messages";

export interface PendingApprovalEntry extends PendingApprovalSummary {
  tabId?: number;
  resolve(payload: ResponsePayload): void;
}

export interface InFlightResolution {
  id: string;
  tabId?: number;
  origin: string;
  request: ProviderRequest;
  entry: PendingApprovalEntry;
  tabClosed: boolean;
}

export interface PairedTabManagerOptions {
  closeWindow?: (windowId: number) => Promise<void>;
}

/**
 * Tracks pending approvals paired with browser tabs (issue #585).
 *
 * Guarantees:
 * 1. If a paired tab closes before approval, pending requests for that tab are
 *    canceled and cleaned up immediately.
 * 2. If the pending queue drains completely, any awaiting popup window is closed.
 * 3. If a paired tab closes after approval has been given but before response
 *    delivery completes, the resolution completes cleanly without throwing
 *    unhandled errors or leaving dangling promises.
 * 4. Newer requests from the same origin+method supersede older ones.
 */
export class PairedTabManager {
  private pending = new Map<string, PendingApprovalEntry>();
  private inFlight = new Map<string, InFlightResolution>();
  public approvalWindowId: number | undefined;

  constructor(private options: PairedTabManagerOptions = {}) {}

  addPending(entry: PendingApprovalEntry): void {
    this.pending.set(entry.id, entry);
  }

  getPending(id: string): PendingApprovalEntry | undefined {
    return this.pending.get(id);
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  listPending(): PendingApprovalSummary[] {
    return [...this.pending.values()].map(({ id, origin, request }) => ({
      id,
      origin,
      request,
    }));
  }

  supersedePending(origin: string, method: string): void {
    for (const [oldId, entry] of this.pending) {
      if (entry.origin === origin && entry.request.method === method) {
        entry.resolve(errorPayload("rejected", "Superseded by a newer request"));
        this.pending.delete(oldId);
      }
    }
  }

  startResolving(id: string): PendingApprovalEntry | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    this.inFlight.set(id, {
      id,
      tabId: entry.tabId,
      origin: entry.origin,
      request: entry.request,
      entry,
      tabClosed: false,
    });
    return entry;
  }

  finishResolving(id: string, payload?: ResponsePayload): void {
    const item = this.inFlight.get(id);
    if (!item) return;
    this.inFlight.delete(id);
    if (payload) {
      try {
        item.entry.resolve(payload);
      } catch {
        // Safe: caller context may have closed
      }
    }
    if (this.pending.size === 0 && this.approvalWindowId !== undefined) {
      void this.closeApprovalWindowIfEmpty();
    }
  }

  isTabClosedForInFlight(id: string): boolean {
    return this.inFlight.get(id)?.tabClosed ?? false;
  }

  async handleTabRemoved(closedTabId: number): Promise<void> {
    // 1. Clean up pending requests from the closed tab
    for (const [id, entry] of this.pending) {
      if (entry.tabId === closedTabId) {
        this.pending.delete(id);
        try {
          entry.resolve(errorPayload("rejected", "The initiating tab was closed"));
        } catch {
          // ignore
        }
      }
    }

    // 2. Mark any in-flight requests from the closed tab
    for (const item of this.inFlight.values()) {
      if (item.tabId === closedTabId) {
        item.tabClosed = true;
      }
    }

    // 3. Close approval window if no pending items remain
    await this.closeApprovalWindowIfEmpty();
  }

  async closeApprovalWindowIfEmpty(): Promise<void> {
    if (this.pending.size === 0 && this.approvalWindowId !== undefined) {
      const winId = this.approvalWindowId;
      this.approvalWindowId = undefined;
      if (this.options.closeWindow) {
        try {
          await this.options.closeWindow(winId);
        } catch {
          // Window may already have closed
        }
      }
    }
  }

  handleWindowRemoved(closedWindowId: number): void {
    if (closedWindowId === this.approvalWindowId) {
      this.approvalWindowId = undefined;
    }
  }
}
