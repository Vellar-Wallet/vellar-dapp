import { errorPayload, type ProviderRequest, type ResponsePayload } from "@vellar/provider-sdk";

// Pending-approval queue (extracted from the background worker so its
// supersede/independence rules are unit-testable — #582). Two tabs, each
// paired to the same wallet, can issue requests concurrently (e.g. both
// requesting a signature); this module's job is only to decide which entries
// in the queue a new request supersedes, never to let two unrelated requests
// collide. The actual Map lives in the background worker (service-worker
// globals aren't test-friendly); this module is the pure decision logic the
// worker calls into.

export interface PendingEntry {
  id: string;
  origin: string;
  request: ProviderRequest;
}

/**
 * Which currently-pending entries a new (origin, request) pair supersedes.
 * Only an entry for the SAME origin AND the SAME method is superseded (e.g.
 * re-clicking "Pair" twice from the same tab/origin) — a request from a
 * different tab/origin, or a different method from the same origin, is
 * always independent and must get its own approval card, never overwrite an
 * unrelated one.
 */
export function supersededEntries(
  pending: ReadonlyMap<string, PendingEntry>,
  newOrigin: string,
  newRequest: ProviderRequest,
): PendingEntry[] {
  const out: PendingEntry[] = [];
  for (const entry of pending.values()) {
    if (entry.origin === newOrigin && entry.request.method === newRequest.method) {
      out.push(entry);
    }
  }
  return out;
}

export function supersededPayload(): ResponsePayload {
  return errorPayload("rejected", "Superseded by a newer request");
}
