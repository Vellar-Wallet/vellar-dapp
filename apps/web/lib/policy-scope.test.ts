import { describe, expect, it } from "vitest";
import type { PolicyDefinition } from "@vellar/types";
import { findScopeConflicts, policyDomains, sharedDomains } from "./policy-scope";

function spending(overrides: Partial<PolicyDefinition> = {}): PolicyDefinition {
  return {
    version: "1",
    type: "spending_limit",
    owners: ["COWNER"],
    spendingLimits: { dailyXlm: "100" },
    ...overrides,
  };
}

function verified(): PolicyDefinition {
  return {
    version: "1",
    type: "verified_only",
    owners: ["COWNER"],
    provenance: { mode: "strict" },
  };
}

function tokenBudget(token: string): PolicyDefinition {
  return {
    version: "1",
    type: "token_spending_limit",
    owners: ["COWNER"],
    tokenBudget: { token, amountBaseUnits: "1000" },
  };
}

function allowlist(contracts: string[]): PolicyDefinition {
  return {
    version: "1",
    type: "contract_allowlist",
    owners: ["COWNER"],
    allowlistedContracts: contracts,
  };
}

describe("policyDomains", () => {
  it("maps each template to its enforcement domain(s)", () => {
    expect(policyDomains(spending())).toEqual(["spend"]);
    expect(policyDomains(verified())).toEqual(["provenance"]);
    expect(policyDomains(tokenBudget("CTOK"))).toEqual(["spend", "spend:CTOK"]);
    expect(policyDomains(allowlist(["CA", "CB"]))).toEqual(["contracts:CA", "contracts:CB"]);
  });
});

describe("findScopeConflicts (#570)", () => {
  it("flags two spending-limit policies as overlapping (happy-path warning)", () => {
    const conflicts = findScopeConflicts(spending(), [
      { label: "CPOLICY1", definition: spending() },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.label).toBe("CPOLICY1");
    expect(conflicts[0]!.domains).toContain("spend");
  });

  it("returns no conflict for two policies that do not overlap at all", () => {
    const conflicts = findScopeConflicts(verified(), [
      { label: "CPOLICY1", definition: spending() },
    ]);
    expect(conflicts).toEqual([]);
    expect(sharedDomains(verified(), spending())).toEqual([]);
  });

  it("flags token-budget overlap on the same token", () => {
    const conflicts = findScopeConflicts(tokenBudget("CTOK"), [
      { label: "CPOLICY1", definition: tokenBudget("CTOK") },
    ]);
    expect(conflicts).toHaveLength(1);
  });

  it("flags allowlist policies only when their contracts intersect", () => {
    expect(
      findScopeConflicts(allowlist(["CA", "CB"]), [
        { label: "CPOLICY1", definition: allowlist(["CB", "CC"]) },
      ]),
    ).toHaveLength(1);
    expect(
      findScopeConflicts(allowlist(["CA"]), [{ label: "CPOLICY1", definition: allowlist(["CB"]) }]),
    ).toEqual([]);
  });

  it("reports every conflicting attached policy, not just the first", () => {
    const conflicts = findScopeConflicts(spending(), [
      { label: "CPOLICY1", definition: spending() },
      { label: "CPOLICY2", definition: tokenBudget("CTOK") },
      { label: "CPOLICY3", definition: verified() },
    ]);
    expect(conflicts.map((c) => c.label).sort()).toEqual(["CPOLICY1", "CPOLICY2"]);
  });
});
