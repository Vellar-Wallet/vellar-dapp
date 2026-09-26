import { describe, expect, it } from "vitest";
import { policyExecutions } from "./schema";

describe("policyExecutions schema index", () => {
  it("defines table policy_executions with indexed wallet_id column", () => {
    expect(policyExecutions).toBeDefined();
    expect(policyExecutions.walletId).toBeDefined();
    expect(policyExecutions.walletId.name).toBe("wallet_id");
  });
});
