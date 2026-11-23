import { describe, expect, it } from "vitest";
import {
  templates,
  getTemplate,
  generatePolicy,
  validateDefinition,
  validateDeployedPolicy,
} from "./templates";
import { buildServer } from "./server";

const C1 = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";

const validSpendingDef = {
  version: "1" as const,
  schemaVersion: 1,
  type: "spending_limit",
  owners: [C1],
  spendingLimits: { dailyXlm: "100" },
};

describe("Policy Template Schema Versioning (#523)", () => {
  it("declares schemaVersion on every template in the registry", () => {
    expect(templates.length).toBeGreaterThan(0);
    for (const template of templates) {
      expect(typeof template.schemaVersion).toBe("number");
      expect(template.schemaVersion).toBeGreaterThanOrEqual(1);
    }
  });

  describe("getTemplate with schemaVersion", () => {
    it("returns template by type and specific schemaVersion", () => {
      const template = getTemplate("spending_limit", 1);
      expect(template).toBeDefined();
      expect(template?.type).toBe("spending_limit");
      expect(template?.schemaVersion).toBe(1);
    });

    it("returns latest template when schemaVersion is omitted", () => {
      const template = getTemplate("spending_limit");
      expect(template).toBeDefined();
      expect(template?.type).toBe("spending_limit");
      expect(template?.schemaVersion).toBe(1);
    });

    it("returns undefined for a schema version that does not exist", () => {
      const template = getTemplate("spending_limit", 999);
      expect(template).toBeUndefined();
    });
  });

  describe("generatePolicy with schemaVersion", () => {
    it("bakes schemaVersion into definition, manifest, and generated policy record", () => {
      const generated = generatePolicy(
        {
          version: "1",
          type: "spending_limit",
          owners: [C1],
          spendingLimits: { dailyXlm: "50" },
        },
        "testnet",
      );

      expect(generated.schemaVersion).toBe(1);
      expect(generated.manifest.schemaVersion).toBe(1);
      expect(generated.definition.schemaVersion).toBe(1);
    });

    it("fails clearly for a schemaVersion higher than any version the codebase defines, instead of falling back to the highest known version (#827)", () => {
      // A rollback, or a record written by a future deployment pointed at an
      // older codebase, can leave a definition referencing a schemaVersion
      // this build has never heard of. getTemplate's exact-match lookup
      // already returns undefined for it rather than guessing the latest
      // known version — this pins that generatePolicy surfaces that as a
      // clear thrown error, not a crash or a silent highest-version fallback.
      const futureSchemaVersion = Math.max(...templates.map((t) => t.schemaVersion)) + 1000;

      expect(() =>
        generatePolicy(
          {
            version: "1",
            schemaVersion: futureSchemaVersion,
            type: "spending_limit",
            owners: [C1],
            spendingLimits: { dailyXlm: "50" },
          },
          "testnet",
        ),
      ).toThrow(new RegExp(`schemaVersion: ${futureSchemaVersion}`));
    });
  });

  describe("validateDefinition & validateDeployedPolicy", () => {
    it("validates a policy matching schemaVersion 1 (happy path)", () => {
      const result = validateDefinition(validSpendingDef);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("ensures an older deployed policy continues to validate correctly against its schema version", () => {
      const deployedRecord = {
        schemaVersion: 1,
        definition: validSpendingDef,
      };
      const result = validateDeployedPolicy(deployedRecord);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("rejects a validation request for a policy whose schema version no longer exists in the codebase", () => {
      const nonExistentVersionDef = {
        ...validSpendingDef,
        schemaVersion: 999,
      };

      const result = validateDefinition(nonExistentVersionDef);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        "schema version 999 does not exist for policy type: spending_limit",
      ]);
    });

    it("rejects deployed policy validation when schema version does not exist", () => {
      const deployedRecord = {
        schemaVersion: 404,
        definition: {
          ...validSpendingDef,
          schemaVersion: 404,
        },
      };

      const result = validateDeployedPolicy(deployedRecord);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        "schema version 404 does not exist for policy type: spending_limit",
      ]);
    });
  });

  describe("HTTP API integration", () => {
    it("POST /policies/validate rejects unknown schema version with error details", async () => {
      const app = buildServer();
      const res = await app.inject({
        method: "POST",
        url: "/policies/validate",
        payload: {
          ...validSpendingDef,
          schemaVersion: 42,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.valid).toBe(false);
      expect(body.errors).toContain(
        "schema version 42 does not exist for policy type: spending_limit",
      );
      await app.close();
    });

    it("POST /policies/generate records schemaVersion on created policy", async () => {
      const app = buildServer();
      const res = await app.inject({
        method: "POST",
        url: "/policies/generate",
        payload: {
          definition: validSpendingDef,
          network: "testnet",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.policy.schemaVersion).toBe(1);
      expect(body.policy.manifest.schemaVersion).toBe(1);
      expect(body.policy.definition.schemaVersion).toBe(1);
      await app.close();
    });
  });
});
