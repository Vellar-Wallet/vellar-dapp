import { describe, expect, it } from "vitest";
import { hasCapability, normalizeOrigin, type PermissionGrant } from "./permissions";

describe("normalizeOrigin", () => {
  it.each([
    ["https://app.example.com", "https://app.example.com"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["https://app.example.com:8443", "https://app.example.com:8443"],
  ])("accepts %s", (input, expected) => {
    expect(normalizeOrigin(input)).toBe(expected);
  });

  it.each([
    ["path attached", "https://app.example.com/evil"],
    ["query attached", "https://app.example.com?x=1"],
    ["trailing slash", "https://app.example.com/"],
    ["not a url", "app.example.com"],
    ["file scheme", "file:///etc/passwd"],
    ["chrome-extension scheme", "chrome-extension://abcdef"],
    ["javascript scheme", "javascript:alert(1)"],
    ["empty", ""],
  ])("rejects %s", (_label, input) => {
    expect(normalizeOrigin(input)).toBeUndefined();
  });
});

describe("hasCapability", () => {
  const grant: PermissionGrant = {
    origin: "https://dapp.example",
    accountId: "CABC",
    network: "testnet",
    capabilities: ["connect", "view_address"],
    grantedAt: "2026-07-16T10:00:00.000Z",
  };

  it("matches origin, network, and capability together", () => {
    expect(hasCapability([grant], "https://dapp.example", "testnet", "view_address")).toBe(true);
  });

  it.each([
    ["different origin", "https://evil.example", "testnet", "view_address"],
    ["different network", "https://dapp.example", "mainnet", "view_address"],
    ["ungranted capability", "https://dapp.example", "testnet", "sign"],
  ] as const)("denies on %s", (_label, origin, network, capability) => {
    expect(hasCapability([grant], origin, network, capability)).toBe(false);
  });

  it("denies with no grants at all", () => {
    expect(hasCapability([], "https://dapp.example", "testnet", "connect")).toBe(false);
  });
});
