import { describe, expect, it } from "vitest";
import { classifyContractTrust } from "./verification";

// #583: the approval screen must tell a contract with NO verification record
// at all apart from one that was explicitly checked and found unverified, and
// both apart from a failed/in-flight lookup.

describe("classifyContractTrust", () => {
  it("a failed lookup is 'error', regardless of any stale result", () => {
    expect(classifyContractTrust(undefined, true)).toBe("error");
    expect(
      classifyContractTrust({ contractId: "C1", status: "verified", recordId: "r1" }, true),
    ).toBe("error");
  });

  it("no result yet (lookup in flight) is 'loading'", () => {
    expect(classifyContractTrust(undefined, false)).toBe("loading");
  });

  it("status 'unverified' with no recordId means no record at all", () => {
    expect(classifyContractTrust({ contractId: "C1", status: "unverified" }, false)).toBe(
      "no_record",
    );
  });

  it("status 'unverified' WITH a recordId is an explicit unverified result, not a missing record", () => {
    expect(
      classifyContractTrust({ contractId: "C1", status: "unverified", recordId: "r1" }, false),
    ).toBe("unverified");
  });

  it("other terminal statuses pass through unchanged", () => {
    expect(
      classifyContractTrust({ contractId: "C1", status: "verified", recordId: "r1" }, false),
    ).toBe("verified");
    expect(
      classifyContractTrust({ contractId: "C1", status: "failed", recordId: "r1" }, false),
    ).toBe("failed");
    expect(
      classifyContractTrust({ contractId: "C1", status: "building", recordId: "r1" }, false),
    ).toBe("building");
  });
});
