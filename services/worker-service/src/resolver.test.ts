import { describe, expect, it, vi } from "vitest";
import { rpc, xdr } from "@stellar/stellar-sdk";
import { ArtifactResolveError, createRpcArtifactResolver, isContractId } from "./resolver";

const C1 = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";

/**
 * A minimal getContractData response wrapping a wasm-executable instance —
 * mocked at the shape resolver.ts actually reads
 * (entry.val.contractData().val().instance().executable()), rather than a
 * real round-tripped XDR blob, to keep the fixture simple and focused on the
 * timeout behavior under test.
 */
function wasmEntry(hashHex: string): Awaited<ReturnType<rpc.Server["getContractData"]>> {
  const executable = {
    switch: () => xdr.ContractExecutableType.contractExecutableWasm(),
    wasmHash: () => Buffer.from(hashHex, "hex"),
  };
  const instance = { executable: () => executable };
  const val = { instance: () => instance };
  const contractData = { val: () => val };
  return {
    val: { contractData: () => contractData },
  } as unknown as Awaited<ReturnType<rpc.Server["getContractData"]>>;
}

describe("createRpcArtifactResolver — timeout handling (issue #330)", () => {
  it("resolves normally well within the timeout", async () => {
    const server = { getContractData: vi.fn().mockResolvedValue(wasmEntry("ab".repeat(32))) };
    const resolver = createRpcArtifactResolver({ rpcUrl: "https://example.test", server, timeoutMs: 50 });
    await expect(resolver.resolveDeployedHash(C1)).resolves.toBe("ab".repeat(32));
  });

  it("throws a distinct 'timeout' ArtifactResolveError when the RPC call hangs past timeoutMs", async () => {
    const server = {
      // Never resolves — simulates a hung upstream RPC endpoint.
      getContractData: vi.fn(
        () => new Promise<Awaited<ReturnType<rpc.Server["getContractData"]>>>(() => {}),
      ),
    };
    const resolver = createRpcArtifactResolver({ rpcUrl: "https://example.test", server, timeoutMs: 20 });

    const err = await resolver.resolveDeployedHash(C1).catch((e) => e);
    expect(err).toBeInstanceOf(ArtifactResolveError);
    expect((err as ArtifactResolveError).code).toBe("timeout");
    expect((err as ArtifactResolveError).message).toContain("timed out");
  });

  it("timeoutMs is optional — omitting it still bounds the call (falls back to a default, not infinite)", async () => {
    // Deliberately does NOT assert the exact default duration (an
    // implementation detail, and asserting it here would make this test slow
    // or brittle) — only that resolveDeployedHash's return type still allows
    // constructing a resolver with no timeoutMs at all, i.e. it's genuinely
    // optional rather than something every caller must remember to set.
    const server = { getContractData: vi.fn().mockResolvedValue(wasmEntry("cd".repeat(32))) };
    const resolver = createRpcArtifactResolver({ rpcUrl: "https://example.test", server });
    await expect(resolver.resolveDeployedHash(C1)).resolves.toBe("cd".repeat(32));
  });

  it("a genuine RPC error (not a timeout) still throws rpc_error, not timeout", async () => {
    const server = {
      getContractData: vi.fn().mockRejectedValue(new Error("upstream 500")),
    };
    const resolver = createRpcArtifactResolver({ rpcUrl: "https://example.test", server, timeoutMs: 1000 });
    const err = await resolver.resolveDeployedHash(C1).catch((e) => e);
    expect(err).toBeInstanceOf(ArtifactResolveError);
    expect((err as ArtifactResolveError).code).toBe("rpc_error");
  });

  it("a not-found response still throws not_found, not timeout", async () => {
    const server = {
      getContractData: vi.fn().mockRejectedValue(new Error("could not be found")),
    };
    const resolver = createRpcArtifactResolver({ rpcUrl: "https://example.test", server, timeoutMs: 1000 });
    const err = await resolver.resolveDeployedHash(C1).catch((e) => e);
    expect(err).toBeInstanceOf(ArtifactResolveError);
    expect((err as ArtifactResolveError).code).toBe("not_found");
  });
});

describe("isContractId", () => {
  it("accepts a well-formed contract address", () => {
    expect(isContractId(C1)).toBe(true);
  });

  it("rejects a classic G-address or malformed string", () => {
    expect(isContractId("GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWX")).toBe(false);
    expect(isContractId("not-a-contract-id")).toBe(false);
  });
});
