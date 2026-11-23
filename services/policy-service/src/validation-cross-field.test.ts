import { describe, it, expect } from "vitest";
import { validateDefinition } from "./validation";

// Cross-field business rules: definitions where every field passes its own
// field-level check (valid amount, valid integer, valid address) but the
// combination is nonsensical. Field-by-field validation alone would accept
// them, so each case below asserts both halves: the fields are individually
// fine, and the definition as a whole is still rejected.

const C1 = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";
const G1 = "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM";

function spending(limits: Record<string, string>) {
  return { version: "1", type: "spending_limit", owners: [C1], spendingLimits: limits };
}

function multisig(threshold: number, owners: string[]) {
  return { version: "1", type: "multisig_threshold", owners, threshold };
}

describe("spending_limit cross-field rule: perTxXlm must not exceed dailyXlm", () => {
  it("accepts a per-transaction cap below the daily cap", () => {
    expect(validateDefinition(spending({ dailyXlm: "100", perTxXlm: "25" }))).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("accepts a per-transaction cap equal to the daily cap (boundary)", () => {
    expect(validateDefinition(spending({ dailyXlm: "100", perTxXlm: "100" })).valid).toBe(true);
  });

  it("rejects a per-transaction cap above the daily cap even though both amounts are valid", () => {
    // Each amount passes the field-level checks on its own.
    expect(validateDefinition(spending({ dailyXlm: "100" })).valid).toBe(true);
    expect(validateDefinition(spending({ perTxXlm: "250" })).valid).toBe(true);

    const result = validateDefinition(spending({ dailyXlm: "100", perTxXlm: "250" }));

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("perTxXlm cannot exceed dailyXlm");
  });

  it("rejects a per-transaction cap one stroop above the daily cap (boundary)", () => {
    const result = validateDefinition(spending({ dailyXlm: "1", perTxXlm: "1.0000001" }));

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("perTxXlm cannot exceed dailyXlm");
  });

  it("compares numerically, not as strings", () => {
    // "9" > "10" lexicographically, but 9 XLM is below 10 XLM.
    expect(validateDefinition(spending({ dailyXlm: "10", perTxXlm: "9" })).valid).toBe(true);
    expect(validateDefinition(spending({ dailyXlm: "9", perTxXlm: "10" })).valid).toBe(false);
  });

  it("does not apply the rule when only one of the two limits is set", () => {
    expect(validateDefinition(spending({ perTxXlm: "5000" })).valid).toBe(true);
    expect(validateDefinition(spending({ dailyXlm: "5000" })).valid).toBe(true);
  });

  it("reports the failing field path so the caller can point at the spending limits", () => {
    const result = validateDefinition(spending({ dailyXlm: "1", perTxXlm: "2" }));

    expect(result.errors[0]).toMatch(/^spendingLimits: /);
  });

  it("does not leak the submitted amounts in the error text", () => {
    const result = validateDefinition(spending({ dailyXlm: "123.4567891", perTxXlm: "987.6543219" }));

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).not.toContain("987.6543219");
  });
});

describe("multisig_threshold cross-field rule: threshold must not exceed the owner count", () => {
  it("accepts a threshold equal to the number of owners (boundary)", () => {
    expect(validateDefinition(multisig(2, [C1, G1])).valid).toBe(true);
  });

  it("accepts a threshold below the number of owners", () => {
    const third = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
    expect(validateDefinition(multisig(2, [C1, G1, third])).valid).toBe(true);
  });

  it("rejects a threshold above the owner count even though the threshold and owners are each valid", () => {
    // threshold 3 is a valid integer >= 2, and two owners is a valid owner list.
    const result = validateDefinition(multisig(3, [C1, G1]));

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("threshold cannot exceed the number of owners");
  });
});

describe("window versus policy expiry", () => {
  // Policy definitions have no overall-expiry field today, so "a spending
  // window longer than the policy's own expiry" cannot be expressed. The strict
  // schema must keep it that way: an expiry-like key is rejected outright
  // rather than silently accepted and ignored next to a long window.
  const tokenPolicy = (extra: Record<string, unknown>) => ({
    version: "1",
    type: "token_spending_limit",
    owners: [C1],
    tokenBudget: { token: C1, amountBaseUnits: "1000000", windowSeconds: 31_536_000 },
    ...extra,
  });

  it("accepts the longest allowed window (365 days) on its own", () => {
    expect(validateDefinition(tokenPolicy({})).valid).toBe(true);
  });

  it("rejects a window beyond the 365 day cap", () => {
    const definition = tokenPolicy({});
    (definition.tokenBudget as { windowSeconds: number }).windowSeconds = 31_536_001;

    const result = validateDefinition(definition);

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("windowSeconds cannot exceed 31,536,000");
  });

  it.each(["expiresAt", "expiresInSeconds", "expiry"])(
    "rejects an unknown %s field instead of ignoring it next to the window",
    (key) => {
      const result = validateDefinition(tokenPolicy({ [key]: 3600 }));

      expect(result.valid).toBe(false);
    },
  );
});
