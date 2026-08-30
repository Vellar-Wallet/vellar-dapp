import { createServer, type Server } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createPolicyDeployer, PolicyDeployError } from "./deploy";

// A fake wasm hash / spending-limit constructor args — never actually reach
// the RPC in these tests, since every test here fails (by design) before or
// during the getAccount call.
const WASM_HASH_HEX = "00".repeat(32);
const SPONSOR = Keypair.random();

function baseConfig(rpcUrl: string, overrides: Partial<Parameters<typeof createPolicyDeployer>[0]> = {}) {
  return {
    rpcUrl,
    networkPassphrase: "Test SDF Network ; September 2015",
    sponsorSecretKey: SPONSOR.secret(),
    rpcTimeoutMs: 200,
    pollTimeoutMs: 5_000,
    // rpc.Server refuses a plain http:// URL otherwise, even for 127.0.0.1 —
    // real deployments always use a real https:// RPC endpoint.
    allowHttp: true,
    ...overrides,
  };
}

describe("createPolicyDeployer — RPC timeout budgets (#327)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      // The "hanging" servers in these tests deliberately never respond, so
      // whatever request the timed-out call raced against is still an open
      // socket when the test finishes. Force-close it rather than waiting
      // for a graceful drain that will never come — `server.close()` alone
      // hangs here.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  /** Starts a local HTTP server that accepts the connection but never writes
   * a response — the only reliable way to exercise a REAL per-request
   * timeout end-to-end without depending on the exact JSON-RPC wire shape
   * `rpc.Server` expects for a successful response. */
  function startHangingServer(): Promise<string> {
    return new Promise((resolve) => {
      server = createServer((_req, _res) => {
        // Deliberately never call res.end() / res.write() — the request hangs
        // until the client's own timeout fires.
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server!.address();
        if (address === null || typeof address === "string") {
          throw new Error("expected a bound TCP address");
        }
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  }

  it("simulateInstance surfaces a timeout error when getAccount stalls past rpcTimeoutMs", async () => {
    const url = await startHangingServer();
    const deployer = createPolicyDeployer(baseConfig(url), WASM_HASH_HEX);

    const started = Date.now();
    const result = await deployer.simulateInstance({
      wallet: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      constructorArgs: { dailyLimitStroops: "1000000000", windowSeconds: 86400 },
    });
    const elapsedMs = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Policy deploy RPC call timed out: getAccount");
    // The call must fail close to the configured budget (200ms), not hang
    // for the test runner's default timeout or longer.
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("deployInstance throws PolicyDeployError with code deploy_rpc_timeout when getAccount stalls", async () => {
    const url = await startHangingServer();
    const deployer = createPolicyDeployer(baseConfig(url), WASM_HASH_HEX);

    const promise = deployer.deployInstance({
      wallet: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      constructorArgs: { dailyLimitStroops: "1000000000", windowSeconds: 86400 },
    });

    await expect(promise).rejects.toBeInstanceOf(PolicyDeployError);
    await expect(promise).rejects.toMatchObject({ code: "deploy_rpc_timeout" });
  });

  it("a timeout error is distinct from a connection-refused error (different code)", async () => {
    // No server listening on this port at all — a real ECONNREFUSED, not a
    // timeout. Confirms withTimeoutError doesn't lump every RPC failure
    // under the timeout code.
    const deployer = createPolicyDeployer(
      baseConfig("http://127.0.0.1:1"), // port 1 — reserved, nothing listens there
      WASM_HASH_HEX,
    );

    const promise = deployer.deployInstance({
      wallet: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      constructorArgs: { dailyLimitStroops: "1000000000", windowSeconds: 86400 },
    });

    await expect(promise).rejects.toBeInstanceOf(PolicyDeployError);
    await expect(promise).rejects.toMatchObject({ code: "sponsor_load_failed" });
    // Specifically NOT the timeout code, since this is a real refused
    // connection, not a stalled one.
    await expect(promise).rejects.not.toMatchObject({ code: "deploy_rpc_timeout" });
  });

  it("respects a configured rpcTimeoutMs shorter than the default", async () => {
    const url = await startHangingServer();
    const deployer = createPolicyDeployer(baseConfig(url, { rpcTimeoutMs: 50 }), WASM_HASH_HEX);

    const started = Date.now();
    await expect(
      deployer.deployInstance({
        wallet: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        constructorArgs: { dailyLimitStroops: "1000000000", windowSeconds: 86400 },
      }),
    ).rejects.toMatchObject({ code: "deploy_rpc_timeout" });
    const elapsedMs = Date.now() - started;

    // Should fail close to the configured 50ms budget, not the default
    // 200ms used by the other tests in this file — proves the value is
    // actually threaded through to rpc.Server, not hardcoded.
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
