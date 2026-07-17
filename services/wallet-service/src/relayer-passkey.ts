import { PasskeyServer } from "passkey-kit/server";
import { rpc, TransactionBuilder } from "@stellar/stellar-sdk";
import type { RelayerConfig } from "./config";
import { createRelayerSubmitter, SubmissionError, type TransactionSubmitter } from "./relayer";

// Thin composition of the real passkey-kit PasskeyServer (v0.13) behind our
// TransactionSubmitter seam. Kept in its own module so tests never load the
// real dependency.

export function createPasskeyServerSubmitter(config: RelayerConfig): TransactionSubmitter {
  const server = new PasskeyServer({
    rpcUrl: config.rpcUrl,
    networkPassphrase: config.networkPassphrase,
    relayer: {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    },
  });

  const inner = createRelayerSubmitter(
    server as unknown as Parameters<typeof createRelayerSubmitter>[0],
  );
  const rpcServer = new rpc.Server(config.rpcUrl);

  return {
    async submit(signedXdr) {
      try {
        return await inner.submit(signedXdr);
      } catch (err) {
        // The relayer's simulation errors are opaque ("VM call trapped").
        // Re-simulate locally to capture the contract's diagnostic events —
        // the RPC error string includes the panic log.
        if (err instanceof SubmissionError) {
          try {
            const tx = TransactionBuilder.fromXDR(signedXdr, config.networkPassphrase);
            const sim = await rpcServer.simulateTransaction(tx);
            if (!rpc.Api.isSimulationSuccess(sim) && "error" in sim) {
              throw new SubmissionError(
                `${err.message} || local simulation: ${sim.error}`,
                err.code,
              );
            }
          } catch (diagErr) {
            if (diagErr instanceof SubmissionError) throw diagErr;
            // Diagnostics are best-effort; never mask the original failure.
          }
        }
        throw err;
      }
    },
  };
}
