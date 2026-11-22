import { describe, expect, it, vi } from "vitest";
import type { VerificationStatusResult } from "@vellar/verification-sdk";
import { classifyContractTrust, lookupContractTrust } from "./verification";

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

// #814: verification-service 503s (and any other thrown failure) must surface
// as an "unknown" error badge, never as "unverified", while the approval screen
// stays usable. The lookup is injectable so this path does not need a server.
describe("lookupContractTrust", () => {
  function clientReturning(result: VerificationStatusResult) {
    return { getStatus: vi.fn().mockResolvedValue(result) };
  }

  it("maps a 503 from the service to 'error', not 'unverified'", async () => {
    const client = {
      getStatus: vi.fn().mockRejectedValue(new Error("503 Service Unavailable")),
    };
    await expect(lookupContractTrust("C1", client)).resolves.toBe("error");
    expect(client.getStatus).toHaveBeenCalledWith("C1");
  });

  it("maps a plain network throw to 'error'", async () => {
    const client = { getStatus: vi.fn().mockRejectedValue(new Error("network down")) };
    await expect(lookupContractTrust("C1", client)).resolves.toBe("error");
  });

  it("passes a verified result through", async () => {
    const client = clientReturning({ contractId: "C1", status: "verified", recordId: "r1" });
    await expect(lookupContractTrust("C1", client)).resolves.toBe("verified");
  });

  it("keeps the no-record distinction on a clean lookup", async () => {
    const client = clientReturning({ contractId: "C1", status: "unverified" });
    await expect(lookupContractTrust("C1", client)).resolves.toBe("no_record");
  });
});
