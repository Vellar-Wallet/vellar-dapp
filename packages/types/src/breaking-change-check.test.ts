import { describe, expect, it } from "vitest";
import {
  assertBreakingChangeComment,
  BreakingChangeConventionError,
  checkBreakingTypeChanges,
  extractBreakingComments,
} from "./breaking-change-check";

const BASE_TYPES = `
export type Network = "testnet" | "mainnet";

export interface WalletSession {
  accountId: string;
  network: Network;
  connected: boolean;
  serverSessionId?: string;
}
`;

describe("breaking-change comment convention check (#552)", () => {
  it("passes when changes are purely additive (new export, new optional property, widened union)", () => {
    const after = `
export type Network = "testnet" | "mainnet" | "futurenet";

export interface WalletSession {
  accountId: string;
  network: Network;
  connected: boolean;
  serverSessionId?: string;
  keyId?: string;
}

export interface NewDomainType {
  id: string;
}
`;
    const result = checkBreakingTypeChanges(BASE_TYPES, after);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(() => assertBreakingChangeComment(BASE_TYPES, after)).not.toThrow();
  });

  it("flags a removed exported type or interface without a BREAKING: comment", () => {
    const after = `
export type Network = "testnet" | "mainnet";
`;
    const result = checkBreakingTypeChanges(BASE_TYPES, after);
    expect(result.ok).toBe(false);
    expect(result.hasBreakingComment).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({
        symbol: "WalletSession",
        kind: "removed_export",
      }),
    ]);
    expect(() => assertBreakingChangeComment(BASE_TYPES, after)).toThrowError(
      BreakingChangeConventionError,
    );
  });

  it("flags a narrowed exported union type without a BREAKING: comment", () => {
    const after = `
export type Network = "testnet";

export interface WalletSession {
  accountId: string;
  network: Network;
  connected: boolean;
  serverSessionId?: string;
}
`;
    const result = checkBreakingTypeChanges(BASE_TYPES, after);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({
        symbol: "Network",
        kind: "narrowed_union",
      }),
    ]);
  });

  it("flags a removed interface property or optional property made required without a BREAKING: comment", () => {
    const after = `
export type Network = "testnet" | "mainnet";

export interface WalletSession {
  accountId: string;
  network: Network;
  serverSessionId: string;
}
`;
    const result = checkBreakingTypeChanges(BASE_TYPES, after);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({
        symbol: "WalletSession.connected",
        kind: "removed_interface_property",
      }),
      expect.objectContaining({
        symbol: "WalletSession.serverSessionId",
        kind: "optional_property_made_required",
      }),
    ]);
  });

  it("accepts a breaking change when an accompanying BREAKING: comment is present in the source or diff", () => {
    const afterWithInlineComment = `
// BREAKING: Dropped mainnet union variant during testnet-only phase.
export type Network = "testnet";

export interface WalletSession {
  accountId: string;
  network: Network;
  connected: boolean;
  serverSessionId?: string;
}
`;
    const inlineResult = assertBreakingChangeComment(BASE_TYPES, afterWithInlineComment);
    expect(inlineResult.ok).toBe(true);
    expect(inlineResult.hasBreakingComment).toBe(true);
    expect(inlineResult.breakingComments).toEqual([
      "Dropped mainnet union variant during testnet-only phase.",
    ]);
    expect(inlineResult.violations).toHaveLength(1);

    const diff = [
      "--- a/packages/types/src/index.ts",
      "+++ b/packages/types/src/index.ts",
      "@@ -1,3 +1,4 @@",
      "+// BREAKING: Removed WalletSession.connected in favor of session status enum",
      '-export type Network = "testnet" | "mainnet";',
      '+export type Network = "testnet";',
    ].join("\n");

    expect(extractBreakingComments("", BASE_TYPES, diff)).toEqual([
      "Removed WalletSession.connected in favor of session status enum",
    ]);
  });
});
