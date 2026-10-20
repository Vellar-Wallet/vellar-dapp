import { beforeEach, describe, expect, it } from "vitest";
import {
  assessProvenance,
  isProvenanceRejection,
  provenancePolicyDefinition,
  provenanceWarningCopy,
  readProvenancePreference,
  shouldWarn,
  writeProvenancePreference,
} from "./provenance";

beforeEach(() => window.localStorage.clear());

describe("provenance preference", () => {
  it("defaults to off and round-trips per account", () => {
    expect(readProvenancePreference("CA")).toEqual({ mode: "off" });
    writeProvenancePreference("CA", { mode: "warn" });
    writeProvenancePreference("CB", {
      mode: "trusted_publishers",
      trustedPublishers: ["github.com/vellar-wallet"],
    });
    expect(readProvenancePreference("CA")).toEqual({ mode: "warn" });
    expect(readProvenancePreference("CB").trustedPublishers).toEqual(["github.com/vellar-wallet"]);
  });

  it("falls back to off on garbage", () => {
    window.localStorage.setItem("vellar.provenance.CA", '{"mode":"yolo"}');
    expect(readProvenancePreference("CA")).toEqual({ mode: "off" });
    window.localStorage.setItem("vellar.provenance.CA", "not json");
    expect(readProvenancePreference("CA")).toEqual({ mode: "off" });
  });
});

describe("provenancePolicyDefinition", () => {
  it("builds the verified_only definition for each on-chain mode", () => {
    expect(provenancePolicyDefinition("CW", "strict")).toEqual({
      version: "1",
      type: "verified_only",
      owners: ["CW"],
      provenance: { mode: "strict" },
    });
    expect(
      provenancePolicyDefinition("CW", "trusted_publishers", ["github.com/acme"]).provenance,
    ).toEqual({ mode: "trusted_publishers", trustedPublishers: ["github.com/acme"] });
  });
});

describe("warn mode assessment", () => {
  const lookup = (status: string | Error) => ({
    getStatus: async () => {
      if (status instanceof Error) throw status;
      return { status: status as never };
    },
  });

  it("classifies verified / unverified / builtin / no-code / unavailable", async () => {
    expect(await assessProvenance({ contractId: "C1" }, lookup("verified"))).toMatchObject({
      level: "verified",
    });
    expect(await assessProvenance({ contractId: "C1" }, lookup("failed"))).toMatchObject({
      level: "unverified",
      status: "failed",
    });
    expect(await assessProvenance({ contractId: "C1" }, lookup("unverified"))).toMatchObject({
      level: "unverified",
    });
    expect(
      await assessProvenance({ contractId: "CNATIVE", isNativeAsset: true }, lookup("x")),
    ).toEqual({ level: "builtin", contractId: "CNATIVE" });
    expect(await assessProvenance({ classicAccount: "G1" }, lookup("x"))).toEqual({
      level: "no-code",
    });
    expect(await assessProvenance({ contractId: "C1" }, lookup(new Error("down")))).toMatchObject({
      level: "unavailable",
    });
  });

  it("warns only in warn mode and only for unverified/superseded/unavailable targets", () => {
    expect(shouldWarn({ mode: "warn" }, { level: "unverified" })).toBe(true);
    expect(shouldWarn({ mode: "warn" }, { level: "superseded" })).toBe(true);
    expect(shouldWarn({ mode: "warn" }, { level: "unavailable" })).toBe(true);
    expect(shouldWarn({ mode: "warn" }, { level: "verified" })).toBe(false);
    expect(shouldWarn({ mode: "warn" }, { level: "builtin" })).toBe(false);
    expect(shouldWarn({ mode: "off" }, { level: "unverified" })).toBe(false);
    expect(shouldWarn({ mode: "off" }, { level: "superseded" })).toBe(false);
    expect(shouldWarn({ mode: "strict" }, { level: "unverified" })).toBe(false);
    expect(shouldWarn({ mode: "strict" }, { level: "superseded" })).toBe(false);
  });

  it("classifies a contract upgraded to an unverified wasm hash as superseded (not verified or unverified)", async () => {
    const HASH_A = "aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff66660000777788889999";
    const HASH_B = "99998888777700006666ffffeeee5555dddd4444cccc3333bbbb2222aaaa1111";

    // Case 1: status still reports the older verified record for HASH_A while on-chain is HASH_B
    const fromStatus = await assessProvenance(
      { contractId: "CUPGRADED", currentWasmHash: HASH_B },
      {
        getStatus: async () => ({
          status: "verified",
          deployedHash: HASH_A,
        }),
      },
    );
    expect(fromStatus).toEqual({
      level: "superseded",
      contractId: "CUPGRADED",
      status: "verified",
      currentWasmHash: HASH_B,
      verifiedWasmHash: HASH_A,
    });

    // Case 2: status reports unverified for current hash, while history shows prior verified HASH_A
    const fromHistory = await assessProvenance(
      { contractId: "CUPGRADED", currentWasmHash: HASH_B },
      {
        getStatus: async () => ({ status: "unverified" }),
        getHistory: async () => [
          { status: "failed", deployedHash: HASH_B },
          { status: "verified", deployedHash: HASH_A },
        ],
      },
    );
    expect(fromHistory).toEqual({
      level: "superseded",
      contractId: "CUPGRADED",
      status: "unverified",
      currentWasmHash: HASH_B,
      verifiedWasmHash: HASH_A,
    });
  });

  it("classifies an upgraded contract as verified when the new wasm hash B has itself been verified", async () => {
    const HASH_A = "aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff66660000777788889999";
    const HASH_B = "99998888777700006666ffffeeee5555dddd4444cccc3333bbbb2222aaaa1111";

    const res = await assessProvenance(
      { contractId: "CUPGRADED", currentWasmHash: `0x${HASH_B.toUpperCase()}` },
      {
        getStatus: async () => ({
          status: "verified",
          deployedHash: HASH_A,
        }),
        getHistory: async () => [
          { status: "verified", deployedHash: HASH_B },
          { status: "verified", deployedHash: HASH_A },
        ],
      },
    );
    expect(res).toEqual({
      level: "verified",
      contractId: "CUPGRADED",
      status: "verified",
      currentWasmHash: `0x${HASH_B.toUpperCase()}`,
      verifiedWasmHash: HASH_B,
    });
  });

  it("warning copy speaks of provenance, never safety guarantees, and distinguishes superseded from unverified", () => {
    for (const level of ["unverified", "superseded", "unavailable"] as const) {
      const copy = provenanceWarningCopy({ level });
      expect(copy).toMatch(/provenance/i);
      expect(copy).not.toMatch(/\bis safe\b|guarantee/i);
    }
    expect(provenanceWarningCopy({ level: "superseded" })).toMatch(/upgraded/i);
    expect(provenanceWarningCopy({ level: "superseded" })).not.toBe(
      provenanceWarningCopy({ level: "unverified" }),
    );
  });
});

describe("isProvenanceRejection", () => {
  it("recognises policy rejections surfaced by the wallet", () => {
    expect(isProvenanceRejection(new Error("Error(Contract, #1)"))).toBe(true);
    expect(isProvenanceRejection(new Error("Error(Contract, #6)"))).toBe(true);
    expect(isProvenanceRejection(new Error("Error(Contract, #110)"))).toBe(true);
    expect(isProvenanceRejection(new Error("Error(Contract, #103)"))).toBe(false);
    expect(isProvenanceRejection(new Error("network"))).toBe(false);
  });
});
