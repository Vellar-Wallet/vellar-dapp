import { beforeEach, describe, expect, it } from "vitest";
import type { PolicyDefinition } from "@vellar/types";
import {
  attachedPolicyDefinitions,
  listPolicyDeployments,
  recordPolicyDeployment,
} from "./policy-deployments";

const ACCOUNT = "CACCOUNT";
const def: PolicyDefinition = {
  version: "1",
  type: "spending_limit",
  owners: [ACCOUNT],
  spendingLimits: { dailyXlm: "100" },
};

beforeEach(() => {
  window.localStorage.clear();
});

describe("policy deployment records (#570)", () => {
  it("records and lists a deployment (happy path)", () => {
    recordPolicyDeployment(ACCOUNT, "CPOL1", def);
    const records = listPolicyDeployments(ACCOUNT);
    expect(records).toHaveLength(1);
    expect(records[0]!.contractId).toBe("CPOL1");
    expect(records[0]!.definition.type).toBe("spending_limit");
  });

  it("de-duplicates by contract id on re-record", () => {
    recordPolicyDeployment(ACCOUNT, "CPOL1", def);
    recordPolicyDeployment(ACCOUNT, "CPOL1", def);
    expect(listPolicyDeployments(ACCOUNT)).toHaveLength(1);
  });

  it("keeps records per account", () => {
    recordPolicyDeployment(ACCOUNT, "CPOL1", def);
    recordPolicyDeployment("COTHER", "CPOL2", def);
    expect(listPolicyDeployments(ACCOUNT).map((r) => r.contractId)).toEqual(["CPOL1"]);
    expect(listPolicyDeployments("COTHER").map((r) => r.contractId)).toEqual(["CPOL2"]);
  });

  it("only surfaces definitions whose contract is still attached", () => {
    recordPolicyDeployment(ACCOUNT, "CPOL1", def);
    recordPolicyDeployment(ACCOUNT, "CPOL2", def);
    const attached = attachedPolicyDefinitions(ACCOUNT, ["CPOL1", "CUNRELATED"]);
    expect(attached).toHaveLength(1);
    expect(attached[0]!.label).toBe("CPOL1");
  });

  it("survives corrupt storage without throwing", () => {
    window.localStorage.setItem(`vellar.policy-deployments:${ACCOUNT}`, "{not json");
    expect(listPolicyDeployments(ACCOUNT)).toEqual([]);
  });
});
