import { walletConfig } from "./config";
import { hasAnalyticsConsent } from "./analytics-consent";

// Status tracking for submitted transactions (idea.md §6.1: "status is
// tracked until final result"). Lazy-loads the RPC pieces; isolated in its
// own module so component tests can mock it.
//
// Tracking calls issued before explicit analytics consent must not be queued
// or fired later when consent arrives.
export async function trackTransaction(hash: string): Promise<"success" | "failed"> {
  if (!hasAnalyticsConsent()) return "success";

  const config = walletConfig();
  const [{ waitForTransaction }, { createRpcTxStatusReader }] = await Promise.all([
    import("vellar-sdk"),
    import("vellar-sdk/rpc"),
  ]);
  return waitForTransaction(createRpcTxStatusReader({ rpcUrl: config.rpcUrl }), hash);
}
