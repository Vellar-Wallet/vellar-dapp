import { describe, expect, it } from "vitest";
import type { ProviderRequest } from "@vellar/provider-sdk";
import { supersededEntries, type PendingEntry } from "./pending-approvals";

// #582: two tabs, each paired to the same wallet, issuing requests
// concurrently must not race on the shared pending-approval queue — each
// gets its own card, and approving/rejecting one must never touch the other.

const TAB_A = "https://dapp-a.example";
const TAB_B = "https://dapp-b.example";

const signReq: ProviderRequest = {
  method: "sign_transaction",
  params: { xdr: "AAAA", network: "testnet" },
};

const connectReq: ProviderRequest = { method: "connect", params: { network: "testnet" } };

function entry(id: string, origin: string, request: ProviderRequest): PendingEntry {
  return { id, origin, request };
}

describe("supersededEntries", () => {
  it("two concurrent sign requests from different tabs/origins are independent — neither supersedes the other", () => {
    const pending = new Map<string, PendingEntry>([["id-a", entry("id-a", TAB_A, signReq)]]);
    const superseded = supersededEntries(pending, TAB_B, signReq);
    expect(superseded).toEqual([]);
  });

  it("a second request from the SAME origin+method supersedes the earlier pending one", () => {
    const pending = new Map<string, PendingEntry>([["id-a", entry("id-a", TAB_A, connectReq)]]);
    const superseded = supersededEntries(pending, TAB_A, connectReq);
    expect(superseded.map((e) => e.id)).toEqual(["id-a"]);
  });

  it("a different method from the SAME origin does not supersede", () => {
    const pending = new Map<string, PendingEntry>([["id-a", entry("id-a", TAB_A, connectReq)]]);
    const superseded = supersededEntries(pending, TAB_A, signReq);
    expect(superseded).toEqual([]);
  });

  it("approving/rejecting one of two concurrent entries leaves the other queued, uncontaminated", () => {
    const pending = new Map<string, PendingEntry>([
      ["id-a", entry("id-a", TAB_A, signReq)],
      ["id-b", entry("id-b", TAB_B, signReq)],
    ]);
    // Resolving id-a (approve or reject) is the caller's job; this module only
    // guarantees id-b was never a candidate for supersession by id-a's origin.
    const supersededByA = supersededEntries(pending, TAB_A, signReq);
    expect(supersededByA.map((e) => e.id)).toEqual(["id-a"]);
    pending.delete("id-a");
    expect(pending.has("id-b")).toBe(true);
    expect(pending.get("id-b")?.origin).toBe(TAB_B);
  });

  it("an empty queue supersedes nothing", () => {
    expect(supersededEntries(new Map(), TAB_A, signReq)).toEqual([]);
  });
});
