import { describe, expect, it } from "vitest";
import { bucketFor, isFlagEnabled, readFlagConfig } from "./feature-flags";

describe("readFlagConfig (#335)", () => {
  it("defaults to 0% rollout and an empty allowlist when unconfigured", () => {
    const cfg = readFlagConfig("policyBuilderV2", {});
    expect(cfg.rolloutPercent).toBe(0);
    expect(cfg.allowlist).toEqual([]);
  });

  it("reads rolloutPercent and allowlist from the camelCase-derived env var names", () => {
    const cfg = readFlagConfig("policyBuilderV2", {
      NEXT_PUBLIC_FLAG_POLICY_BUILDER_V2_ROLLOUT_PERCENT: "25",
      NEXT_PUBLIC_FLAG_POLICY_BUILDER_V2_ALLOWLIST: "GACCT1,GACCT2",
    });
    expect(cfg.rolloutPercent).toBe(25);
    expect(cfg.allowlist).toEqual(["GACCT1", "GACCT2"]);
  });

  it("also accepts the SCREAMING_SNAKE_CASE form directly", () => {
    const cfg = readFlagConfig("POLICY_BUILDER_V2", {
      NEXT_PUBLIC_FLAG_POLICY_BUILDER_V2_ROLLOUT_PERCENT: "50",
    });
    expect(cfg.rolloutPercent).toBe(50);
  });

  it("trims whitespace and drops empty entries from the allowlist", () => {
    const cfg = readFlagConfig("f", {
      NEXT_PUBLIC_FLAG_F_ALLOWLIST: " GACCT1 , , GACCT2,",
    });
    expect(cfg.allowlist).toEqual(["GACCT1", "GACCT2"]);
  });

  it("fails closed (0%) on a non-numeric rolloutPercent rather than throwing", () => {
    const cfg = readFlagConfig("f", { NEXT_PUBLIC_FLAG_F_ROLLOUT_PERCENT: "not-a-number" });
    expect(cfg.rolloutPercent).toBe(0);
  });

  it("clamps a rolloutPercent above 100 down to 100", () => {
    const cfg = readFlagConfig("f", { NEXT_PUBLIC_FLAG_F_ROLLOUT_PERCENT: "500" });
    expect(cfg.rolloutPercent).toBe(100);
  });

  it("clamps a negative rolloutPercent up to 0", () => {
    const cfg = readFlagConfig("f", { NEXT_PUBLIC_FLAG_F_ROLLOUT_PERCENT: "-10" });
    expect(cfg.rolloutPercent).toBe(0);
  });
});

describe("bucketFor (#335)", () => {
  it("is deterministic — the same accountId always produces the same bucket", () => {
    const id = "GACCOUNTIDEXAMPLE1234567890";
    const first = bucketFor(id);
    for (let i = 0; i < 20; i++) {
      expect(bucketFor(id)).toBe(first);
    }
  });

  it("stays within [0, 100) for a range of inputs", () => {
    for (let i = 0; i < 200; i++) {
      const bucket = bucketFor(`GACCOUNT${i}`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
    }
  });

  it("distributes across the range rather than collapsing to one value", () => {
    const buckets = new Set<number>();
    for (let i = 0; i < 500; i++) {
      buckets.add(bucketFor(`GACCOUNT${i}`));
    }
    // Not asserting a specific distribution shape — just that 500 distinct
    // inputs don't all collide into a handful of buckets, which would make
    // "percentage rollout" meaningless.
    expect(buckets.size).toBeGreaterThan(50);
  });

  it("produces different buckets for different accountIds (not a constant function)", () => {
    const a = bucketFor("GACCOUNTAAAAAAAAAAAAAAAAAAAA");
    const b = bucketFor("GACCOUNTBBBBBBBBBBBBBBBBBBBB");
    // Extremely unlikely to collide for two arbitrary distinct strings;
    // if this ever flakes, the hash function itself has a real bug.
    expect(a).not.toBe(b);
  });
});

describe("isFlagEnabled (#335)", () => {
  it("returns false when accountId is null (no connected wallet yet)", () => {
    expect(isFlagEnabled({ rolloutPercent: 100, allowlist: [] }, null)).toBe(false);
  });

  it("returns false at 0% rollout for an account not on the allowlist", () => {
    expect(isFlagEnabled({ rolloutPercent: 0, allowlist: [] }, "GANYACCOUNT")).toBe(false);
  });

  it("returns true at 100% rollout for any account", () => {
    for (let i = 0; i < 20; i++) {
      expect(isFlagEnabled({ rolloutPercent: 100, allowlist: [] }, `GACCOUNT${i}`)).toBe(true);
    }
  });

  it("an allowlisted account sees the flag even at 0% rollout", () => {
    const cfg = { rolloutPercent: 0, allowlist: ["GBETATESTER"] };
    expect(isFlagEnabled(cfg, "GBETATESTER")).toBe(true);
  });

  it("a non-allowlisted account respects the percentage rollout, not the allowlist", () => {
    const account = "GNOTONLIST";
    const bucket = bucketFor(account);
    const cfgJustBelow = { rolloutPercent: bucket, allowlist: [] }; // bucket < rolloutPercent is false when equal
    const cfgJustAbove = { rolloutPercent: bucket + 1, allowlist: [] };
    expect(isFlagEnabled(cfgJustBelow, account)).toBe(false);
    expect(isFlagEnabled(cfgJustAbove, account)).toBe(true);
  });

  it("the same account consistently sees the same flagged/unflagged UI across repeated calls", () => {
    const cfg = { rolloutPercent: 50, allowlist: [] };
    const account = "GSTABLEUSER";
    const first = isFlagEnabled(cfg, account);
    for (let i = 0; i < 10; i++) {
      expect(isFlagEnabled(cfg, account)).toBe(first);
    }
  });
});
