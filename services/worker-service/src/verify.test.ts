import { describe, expect, it } from "vitest";
import { hashArtifact, hashesMatch, normalizeHash } from "./artifact";
import { BuildExecutorError, stubBuildExecutor, type BuildExecutor } from "./executor";
import { ArtifactResolveError, createStaticArtifactResolver, isContractId } from "./resolver";
import { runVerification } from "./verify";

const C1 = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";

const repoJob = {
  contractId: C1,
  sourceType: "repo" as const,
  repoUrl: "https://github.com/example/contract",
  commitHash: "a1b2c3d",
  toolchainVersion: "1.81.0",
  buildFlags: ["--release"],
};

describe("hashArtifact / normalizeHash / hashesMatch", () => {
  it("produces a stable lowercase-hex sha256", () => {
    const h = hashArtifact(new TextEncoder().encode("hello"));
    expect(h).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("normalizes 0x-prefix and casing", () => {
    expect(normalizeHash("0xABCDEF")).toBe("abcdef");
    expect(normalizeHash("  ABCdef  ")).toBe("abcdef");
  });

  it("matches regardless of formatting, but never matches empty", () => {
    expect(hashesMatch("0xABC", "abc")).toBe(true);
    expect(hashesMatch("abc", "abd")).toBe(false);
    expect(hashesMatch("", "")).toBe(false);
  });
});

describe("stubBuildExecutor", () => {
  it("is deterministic for identical inputs", async () => {
    const ex = stubBuildExecutor();
    const a = await ex.build(repoJob);
    const b = await ex.build(repoJob);
    expect(a.wasmHash).toBe(b.wasmHash);
    expect(a.wasmHash).toBe(hashArtifact(a.wasm));
  });

  it("differs when inputs differ (commit, toolchain, flags)", async () => {
    const ex = stubBuildExecutor();
    const base = await ex.build(repoJob);
    const diffCommit = await ex.build({ ...repoJob, commitHash: "9999999" });
    const diffToolchain = await ex.build({ ...repoJob, toolchainVersion: "1.82.0" });
    const diffFlags = await ex.build({ ...repoJob, buildFlags: [] });
    expect(
      new Set([base.wasmHash, diffCommit.wasmHash, diffToolchain.wasmHash, diffFlags.wasmHash])
        .size,
    ).toBe(4);
  });
});

describe("createStaticArtifactResolver", () => {
  it("returns the normalized deployed hash", async () => {
    const resolver = createStaticArtifactResolver({ [C1]: "0xDEADBEEF" });
    expect(await resolver.resolveDeployedHash(C1)).toBe("deadbeef");
  });

  it("throws not_found for an unknown contract", async () => {
    const resolver = createStaticArtifactResolver({});
    await expect(resolver.resolveDeployedHash(C1)).rejects.toBeInstanceOf(ArtifactResolveError);
  });
});

describe("isContractId", () => {
  it("accepts C-addresses, rejects G-addresses and junk", () => {
    expect(isContractId(C1)).toBe(true);
    expect(isContractId("GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM")).toBe(false);
    expect(isContractId("not-an-address")).toBe(false);
  });
});

describe("runVerification", () => {
  it("returns verified when the rebuilt hash matches the deployed hash", async () => {
    const executor = stubBuildExecutor();
    // Deployed hash == what the stub will build, so this is a match.
    const built = await executor.build(repoJob);
    const resolver = createStaticArtifactResolver({ [C1]: built.wasmHash });

    const outcome = await runVerification(repoJob, { executor, resolver });
    expect(outcome.status).toBe("verified");
    expect(outcome.outputHash).toBe(built.wasmHash);
    expect(outcome.deployedHash).toBe(built.wasmHash);
    expect(outcome.log).toContain("Verified");
  });

  it("returns failed with both hashes when they mismatch", async () => {
    const executor = stubBuildExecutor();
    const resolver = createStaticArtifactResolver({ [C1]: "a".repeat(64) });

    const outcome = await runVerification(repoJob, { executor, resolver });
    expect(outcome.status).toBe("failed");
    expect(outcome.deployedHash).toBe("a".repeat(64));
    expect(outcome.outputHash).toBeTruthy();
    expect(outcome.log).toContain("Mismatch");
  });

  it("returns failed (no build attempted) when the contract can't be resolved", async () => {
    let buildCalled = false;
    const executor: BuildExecutor = {
      async build(input) {
        buildCalled = true;
        return stubBuildExecutor().build(input);
      },
    };
    const resolver = createStaticArtifactResolver({}); // C1 absent

    const outcome = await runVerification(repoJob, { executor, resolver });
    expect(outcome.status).toBe("failed");
    expect(outcome.log).toContain("Could not resolve");
    expect(buildCalled).toBe(false); // resolve happens first; no wasted build
  });

  it("returns failed (with deployed hash) when the build errors", async () => {
    const executor: BuildExecutor = {
      async build() {
        throw new BuildExecutorError("compile blew up", "build_failed", "rustc: error[E0432]");
      },
    };
    const resolver = createStaticArtifactResolver({ [C1]: "b".repeat(64) });

    const outcome = await runVerification(repoJob, { executor, resolver });
    expect(outcome.status).toBe("failed");
    expect(outcome.deployedHash).toBe("b".repeat(64));
    expect(outcome.outputHash).toBeUndefined();
    expect(outcome.log).toContain("Build failed");
    expect(outcome.log).toContain("E0432");
  });

  it("propagates truly unexpected errors from the resolver", async () => {
    const executor = stubBuildExecutor();
    const resolver = {
      async resolveDeployedHash(): Promise<string> {
        throw new TypeError("boom");
      },
    };
    await expect(runVerification(repoJob, { executor, resolver })).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});
