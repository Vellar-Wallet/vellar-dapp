import type { CleanupPlan } from "@vela/types";
import { walletConfig } from "./config";

// Cleanup wizard data layer (technical-doc.md §7.7; decisions.md option A).
// Kept UI-free so the wizard components stay purely presentational.

export interface CleanupStep {
  title: string;
  description: string;
  xdr: string;
  hash: string;
}

export class LifecycleApiError extends Error {
  readonly status: number;
  readonly plan?: CleanupPlan;

  constructor(message: string, status: number, plan?: CleanupPlan) {
    super(message);
    this.name = "LifecycleApiError";
    this.status = status;
    this.plan = plan;
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${walletConfig().apiUrl}/lifecycle/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
    plan?: CleanupPlan;
  };
  if (!res.ok) {
    throw new LifecycleApiError(
      payload.message ?? payload.error ?? `Request failed (${res.status})`,
      res.status,
      payload.plan,
    );
  }
  return payload as T;
}

export function planCleanup(
  accountId: string,
  destination: string,
): Promise<{ plan: CleanupPlan }> {
  return post("plan", { accountId, destination });
}

export function executeCleanup(
  accountId: string,
  destination: string,
): Promise<{ steps: CleanupStep[]; plan: CleanupPlan }> {
  return post("execute", { accountId, destination });
}

export function buildMerge(accountId: string, destination: string): Promise<{ step: CleanupStep }> {
  return post("merge", { accountId, destination });
}

/** Stellar Laboratory transaction-signer link for an unsigned XDR. */
export function labSignUrl(xdr: string): string {
  const network = walletConfig().network === "mainnet" ? "public" : "test";
  return `https://laboratory.stellar.org/#txsigner?xdr=${encodeURIComponent(xdr)}&network=${network}`;
}

/**
 * Watches Horizon until the transaction hash appears (auto-advance for the
 * wizard). Resolves true when seen, false when the deadline passes — the UI
 * offers "keep waiting".
 */
export async function watchTransaction(
  hash: string,
  options: { timeoutMs?: number; intervalMs?: number; cancelled?: () => boolean } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const intervalMs = options.intervalMs ?? 4_000;
  const deadline = Date.now() + timeoutMs;
  const base = walletConfig().horizonUrl.replace(/\/+$/, "");

  for (;;) {
    if (options.cancelled?.()) return false;
    const res = await fetch(`${base}/transactions/${hash}`).catch(() => undefined);
    if (res?.ok) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
