import { walletConfig } from "./config";

// Status tracking for submitted transactions (idea.md §6.1: "status is
// tracked until final result"). Lazy-loads the RPC pieces; isolated in its
// own module so component tests can mock it.

export async function trackTransaction(hash: string): Promise<"success" | "failed"> {
  const config = walletConfig();
  const [{ waitForTransaction }, { createRpcTxStatusReader }] = await Promise.all([
    import("@vela/wallet-sdk"),
    import("@vela/wallet-sdk/rpc"),
  ]);
  return waitForTransaction(createRpcTxStatusReader({ rpcUrl: config.rpcUrl }), hash);
}
