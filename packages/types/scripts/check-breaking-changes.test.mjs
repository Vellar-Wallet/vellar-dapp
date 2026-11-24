import { describe, expect, it } from "vitest";
import { parseDiffForBreakingChanges } from "./check-breaking-changes.mjs";

describe("parseDiffForBreakingChanges (issue #552)", () => {
  it.each([
    ["without a BREAKING comment", "", ["Network"]],
    ["with a BREAKING comment", "+// BREAKING: mainnet no longer accepts public access.\n", []],
  ])("checks a union narrowed by an intersection %s", (_label, comment, expected) => {
    const diff = `
diff --git a/packages/types/src/index.ts b/packages/types/src/index.ts
--- a/packages/types/src/index.ts
+++ b/packages/types/src/index.ts
@@ -1 +1,${comment ? 2 : 1} @@
-export type Network = { name: "testnet"; access: "public" } | { name: "mainnet"; access: "public" | "private" };
${comment}+export type Network = ({ name: "testnet"; access: "public" } | { name: "mainnet"; access: "public" | "private" }) & ({ name: "testnet" } | { access: "private" });
`;
    expect(parseDiffForBreakingChanges(diff)).toEqual(expected);
  });

  it("flags a removed exported type without a BREAKING comment", () => {
    const diff = `
diff --git a/packages/types/src/index.ts b/packages/types/src/index.ts
--- a/packages/types/src/index.ts
+++ b/packages/types/src/index.ts
@@ -1,5 +1,4 @@
 export type Network = "testnet" | "mainnet";
-export type OldType = string;
 export interface Keep {}
`;
    expect(parseDiffForBreakingChanges(diff)).toEqual(["OldType"]);
  });

  it("does not flag a removed exported type with a BREAKING comment", () => {
    const diff = `
diff --git a/packages/types/src/index.ts b/packages/types/src/index.ts
--- a/packages/types/src/index.ts
+++ b/packages/types/src/index.ts
@@ -1,5 +1,4 @@
 export type Network = "testnet" | "mainnet";
+// BREAKING: OldType removed in v2
-export type OldType = string;
 export interface Keep {}
`;
    expect(parseDiffForBreakingChanges(diff)).toEqual([]);
  });

  it("flags multiple removed exports in one hunk without BREAKING", () => {
    const diff = `
--- a/packages/types/src/index.ts
+++ b/packages/types/src/index.ts
@@ -1,5 +1,3 @@
 export type Network = "testnet" | "mainnet";
-export type Foo = string;
-export interface Bar {}
 export interface Keep {}
`;
    expect(parseDiffForBreakingChanges(diff)).toEqual(["Foo", "Bar"]);
  });

  it("does not flag added or modified types", () => {
    const diff = `
--- a/packages/types/src/index.ts
+++ b/packages/types/src/index.ts
@@ -1,3 +1,4 @@
 export type Network = "testnet" | "mainnet";
+export type NewType = number;
 export interface Keep {}
`;
    expect(parseDiffForBreakingChanges(diff)).toEqual([]);
  });

  it("returns empty for an empty diff", () => {
    expect(parseDiffForBreakingChanges("")).toEqual([]);
  });

  it("does not flag removed non-exported declarations", () => {
    const diff = `
--- a/packages/types/src/index.ts
+++ b/packages/types/src/index.ts
@@ -1,3 +1,2 @@
 export type Network = "testnet" | "mainnet";
-type Internal = string;
 export interface Keep {}
`;
    expect(parseDiffForBreakingChanges(diff)).toEqual([]);
  });
});
