import { describe, it, expect } from "vitest";
import {
  redactAuditEvent,
  hashForRedaction,
  generateRedactionSalt,
  type AuditEvent,
} from "./audit-redaction";

describe("audit-redaction", () => {
  describe("generateRedactionSalt", () => {
    it("generates a 64-character hex string (256 bits)", () => {
      const salt = generateRedactionSalt();
      expect(salt).toMatch(/^[0-9a-f]{64}$/);
      expect(salt).toHaveLength(64);
    });

    it("generates different salts on each call", () => {
      const salt1 = generateRedactionSalt();
      const salt2 = generateRedactionSalt();
      expect(salt1).not.toBe(salt2);
    });
  });

  describe("hashForRedaction", () => {
    it("produces a 12-character hex hash", () => {
      const salt = generateRedactionSalt();
      const hash = hashForRedaction("GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", salt);
      expect(hash).toMatch(/^[0-9a-f]{12}$/);
      expect(hash).toHaveLength(12);
    });

    it("produces deterministic output (same input → same hash)", () => {
      const salt = generateRedactionSalt();
      const accountId = "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
      const hash1 = hashForRedaction(accountId, salt);
      const hash2 = hashForRedaction(accountId, salt);
      expect(hash1).toBe(hash2);
    });

    it("produces different hashes for different inputs", () => {
      const salt = generateRedactionSalt();
      const hash1 = hashForRedaction("GAAA...AAAA", salt);
      const hash2 = hashForRedaction("GBBB...BBBB", salt);
      expect(hash1).not.toBe(hash2);
    });

    it("produces different hashes for different salts (same value)", () => {
      const salt1 = generateRedactionSalt();
      const salt2 = generateRedactionSalt();
      const accountId = "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
      const hash1 = hashForRedaction(accountId, salt1);
      const hash2 = hashForRedaction(accountId, salt2);
      expect(hash1).not.toBe(hash2);
    });

    it("is one-way: cannot recover original from hash", () => {
      const salt = generateRedactionSalt();
      const original = "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
      const hash = hashForRedaction(original, salt);
      // Hash is 12 characters; original is 56 characters — data is lost
      expect(hash.length).toBeLessThan(original.length);
      // Cannot reverse SHA256 hash
      expect(hash).not.toContain("GXXX");
      expect(hash).not.toContain("XXX");
    });
  });

  describe("redactAuditEvent", () => {
    const salt = generateRedactionSalt();

    describe("POST /lifecycle/plan (cleanup_planned event)", () => {
      it("hashes accountId and destination for correlation", () => {
        const accountId = "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
        const destination = "GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY";

        const event: AuditEvent = {
          type: "lifecycle.cleanup_planned",
          at: "2026-08-29T14:30:00Z",
          data: {
            plan: {
              accountId,
              destination,
              blockers: [],
              estimatedTransactions: 1,
              mergeReady: true,
            },
          },
        };

        const redacted = redactAuditEvent(event, salt);

        // Account IDs are hashed, not dropped or plaintext
        expect(redacted.data.plan).toBeDefined();
        expect((redacted.data.plan as Record<string, unknown>).accountRef).toBeDefined();
        expect((redacted.data.plan as Record<string, unknown>).destinationRef).toBeDefined();

        // Hashes are deterministic
        const hash1 = (redacted.data.plan as Record<string, unknown>).accountRef;
        const event2 = redactAuditEvent(event, salt);
        const hash2 = (event2.data.plan as Record<string, unknown>).accountRef;
        expect(hash1).toBe(hash2);

        // Raw account IDs DO NOT appear anywhere in redacted event
        const redactedStr = JSON.stringify(redacted);
        expect(redactedStr).not.toContain(accountId);
        expect(redactedStr).not.toContain(destination);
      });

      it("preserves estimatedTransactions and mergeReady", () => {
        const event: AuditEvent = {
          type: "lifecycle.cleanup_planned",
          at: "2026-08-29T14:30:00Z",
          data: {
            plan: {
              accountId: "GXXXXX...",
              destination: "GYYYY...",
              blockers: [],
              estimatedTransactions: 3,
              mergeReady: false,
            },
          },
        };

        const redacted = redactAuditEvent(event, salt);
        const plan = redacted.data.plan as Record<string, unknown>;

        expect(plan.estimatedTransactions).toBe(3);
        expect(plan.mergeReady).toBe(false);
      });

      it("extracts blocker types and drops descriptions", () => {
        const event: AuditEvent = {
          type: "lifecycle.cleanup_planned",
          at: "2026-08-29T14:30:00Z",
          data: {
            plan: {
              accountId: "GXXXXX...",
              destination: "GYYYY...",
              blockers: [
                {
                  type: "balance",
                  description: "Holds 100.5 USDC from issuer GZZZZZZZZ...",
                  actionRequired: "Transfer the balance...",
                },
                {
                  type: "trustline",
                  description: "Trustline to USDC",
                  actionRequired: "Remove the trustline...",
                },
                {
                  type: "offer",
                  description: "3 open DEX offers",
                  actionRequired: "Cancel all offers...",
                },
              ],
              estimatedTransactions: 2,
              mergeReady: false,
            },
          },
        };

        const redacted = redactAuditEvent(event, salt);
        const plan = redacted.data.plan as Record<string, unknown>;

        // Blocker types are preserved
        expect(plan.blockerTypes).toEqual(["balance", "offer", "trustline"]); // sorted
        expect(plan.blockerCount).toBe(3);

        // Descriptions are NOT present
        const redactedStr = JSON.stringify(redacted);
        expect(redactedStr).not.toContain("Holds 100.5 USDC");
        expect(redactedStr).not.toContain("Transfer the balance");
        expect(redactedStr).not.toContain("USDC");
      });

      it("handles missing or null blockers gracefully", () => {
        const event: AuditEvent = {
          type: "lifecycle.cleanup_planned",
          at: "2026-08-29T14:30:00Z",
          data: {
            plan: {
              accountId: "GXXXXX...",
              destination: "GYYYY...",
              blockers: null,
              estimatedTransactions: 1,
              mergeReady: true,
            },
          },
        };

        const redacted = redactAuditEvent(event, salt);
        const plan = redacted.data.plan as Record<string, unknown>;

        // Missing blockers should not crash; blockerTypes should be absent or empty
        expect(plan).toBeDefined();
        if (plan.blockerTypes) {
          expect(Array.isArray(plan.blockerTypes)).toBe(true);
        }
      });
    });

    describe("POST /lifecycle/execute (cleanup_executed event)", () => {
      it("redacts steps and plan together", () => {
        const accountId = "GXXXXX...";
        const destination = "GYYYY...";

        const event: AuditEvent = {
          type: "lifecycle.cleanup_executed",
          at: "2026-08-29T14:30:00Z",
          data: {
            plan: {
              accountId,
              destination,
              blockers: [
                {
                  type: "balance",
                  description: "Holds 100 USDC",
                  actionRequired: "Transfer...",
                },
              ],
              estimatedTransactions: 2,
              mergeReady: false,
            },
            steps: [
              {
                title: "Clean up the account (1/2)",
                description: `Closes ${accountId} and sends...`, // Contains account ID
                xdr: "base64-encoded-full-transaction-with-account-ids",
                hash: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
              },
            ],
          },
        };

        const redacted = redactAuditEvent(event, salt);

        // Plan is redacted
        const plan = redacted.data.plan as Record<string, unknown>;
        expect(plan.accountRef).toBeDefined();
        expect(plan.destinationRef).toBeDefined();

        // Steps are redacted: title/hash preserved, description/xdr dropped
        const steps = redacted.data.steps as Record<string, unknown>[];
        expect(steps).toHaveLength(1);
        expect(steps[0].title).toBe("Clean up the account (1/2)");
        expect(steps[0].hash).toBe("a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6");

        // Description and XDR are not present
        const redactedStr = JSON.stringify(redacted);
        expect(redactedStr).not.toContain("Closes");
        expect(redactedStr).not.toContain("base64-encoded");
      });
    });

    describe("POST /lifecycle/merge (account_merged event)", () => {
      it("redacts merge step: keeps hash/title, drops description/xdr", () => {
        const event: AuditEvent = {
          type: "lifecycle.account_merged",
          at: "2026-08-29T14:30:00Z",
          data: {
            step: {
              title: "Merge and close the account",
              description:
                "Closes GXXXXX...XXXXX and sends its entire XLM balance to GYYYY...YYYY",
              xdr: "base64-full-transaction-envelope",
              hash: "9a8b7c6d5e4f3g2h1i0j9k8l7m6n5o4p",
            },
          },
        };

        const redacted = redactAuditEvent(event, salt);
        const step = redacted.data.step as Record<string, unknown>;

        // Title and hash preserved
        expect(step.title).toBe("Merge and close the account");
        expect(step.hash).toBe("9a8b7c6d5e4f3g2h1i0j9k8l7m6n5o4p");

        // Description and XDR dropped
        const redactedStr = JSON.stringify(redacted);
        expect(redactedStr).not.toContain("Closes");
        expect(redactedStr).not.toContain("base64");
      });
    });

    describe("POST /lifecycle/inspect (account_inspected event)", () => {
      it("drops the entire HorizonAccount object (no audit value)", () => {
        const event: AuditEvent = {
          type: "lifecycle.account_inspected",
          at: "2026-08-29T14:30:00Z",
          data: {
            account: {
              accountId: "GXXXXX...",
              sequence: "12345",
              balances: [
                {
                  assetType: "native",
                  balance: "1000.5",
                },
                {
                  assetType: "credit_alphanum4",
                  assetCode: "USDC",
                  assetIssuer: "GZZZ...",
                  balance: "100",
                },
              ],
              dataKeys: ["user_id", "profile"],
              offers: [
                {
                  id: "123456",
                  sellingAssetType: "native",
                  buyingAssetType: "credit_alphanum4",
                  buyingAssetCode: "USDC",
                  buyingAssetIssuer: "GZZZ...",
                  price: "2.5",
                },
              ],
              openOffers: 1,
            },
          },
        };

        const redacted = redactAuditEvent(event, salt);

        // Account object should not be present
        expect(redacted.data.account).toBeUndefined();

        // No PII should leak
        const redactedStr = JSON.stringify(redacted);
        expect(redactedStr).not.toContain("USDC");
        expect(redactedStr).not.toContain("user_id");
        expect(redactedStr).not.toContain("profile");
        expect(redactedStr).not.toContain("GZZZ");
      });
    });

    describe("Unknown event type", () => {
      it("applies conservative redaction (drops known PII fields)", () => {
        const event: AuditEvent = {
          type: "lifecycle.unknown_event",
          at: "2026-08-29T14:30:00Z",
          data: {
            status: "success",
            count: 5,
            accountId: "GXXXXX...",
            description: "Some user-facing description",
            account: { /* full object */ },
            offers: [],
          },
        };

        const redacted = redactAuditEvent(event, salt);

        // Primitives that are not known PII fields are preserved
        expect(redacted.data.status).toBe("success");
        expect(redacted.data.count).toBe(5);

        // Known PII fields are dropped
        expect(redacted.data.accountId).toBeUndefined();
        expect(redacted.data.description).toBeUndefined();
        expect(redacted.data.account).toBeUndefined();
        expect(redacted.data.offers).toBeUndefined();
      });
    });

    describe("Regression: Correlation Across Events", () => {
      it("same account produces same hash across different event types", () => {
        const accountId = "GXXXXX...";
        const salt1 = generateRedactionSalt();

        const event1: AuditEvent = {
          type: "lifecycle.cleanup_planned",
          at: "2026-08-29T14:30:00Z",
          data: {
            plan: {
              accountId,
              destination: "GYYYY...",
              blockers: [],
              estimatedTransactions: 1,
              mergeReady: true,
            },
          },
        };

        const event2: AuditEvent = {
          type: "lifecycle.cleanup_executed",
          at: "2026-08-29T14:31:00Z",
          data: {
            plan: {
              accountId,
              destination: "GYYYY...",
              blockers: [],
              estimatedTransactions: 1,
              mergeReady: true,
            },
            steps: [],
          },
        };

        const redacted1 = redactAuditEvent(event1, salt1);
        const redacted2 = redactAuditEvent(event2, salt1);

        const hash1 = (redacted1.data.plan as Record<string, unknown>).accountRef;
        const hash2 = (redacted2.data.plan as Record<string, unknown>).accountRef;

        // Same account, same salt → same hash
        expect(hash1).toBe(hash2);
      });

      it("different accounts produce different hashes (no false correlation)", () => {
        const salt1 = generateRedactionSalt();

        const event1: AuditEvent = {
          type: "lifecycle.cleanup_planned",
          at: "2026-08-29T14:30:00Z",
          data: {
            plan: {
              accountId: "GAAAA...",
              destination: "GYYYY...",
              blockers: [],
              estimatedTransactions: 1,
              mergeReady: true,
            },
          },
        };

        const event2: AuditEvent = {
          type: "lifecycle.cleanup_planned",
          at: "2026-08-29T14:30:00Z",
          data: {
            plan: {
              accountId: "GBBBB...",
              destination: "GYYYY...",
              blockers: [],
              estimatedTransactions: 1,
              mergeReady: true,
            },
          },
        };

        const redacted1 = redactAuditEvent(event1, salt1);
        const redacted2 = redactAuditEvent(event2, salt1);

        const hash1 = (redacted1.data.plan as Record<string, unknown>).accountRef;
        const hash2 = (redacted2.data.plan as Record<string, unknown>).accountRef;

        // Different accounts → different hashes
        expect(hash1).not.toBe(hash2);
      });
    });

    describe("No PII Leakage Regression Test", () => {
      it("full cleanup_planned event contains no raw account IDs, data keys, or offer details", () => {
        const accountId = "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
        const destination = "GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY";
        const issuer = "GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";

        const event: AuditEvent = {
          type: "lifecycle.cleanup_planned",
          at: "2026-08-29T14:30:00Z",
          data: {
            plan: {
              accountId,
              destination,
              blockers: [
                {
                  type: "balance",
                  description: `Holds 1000.5 USDC from issuer ${issuer}`,
                  actionRequired: "Transfer or burn the USDC balance",
                },
                {
                  type: "trustline",
                  description: "Trustline to USDC",
                  actionRequired: "Remove the trustline",
                },
                {
                  type: "data",
                  description: 'Managed data entry "user_id"',
                  actionRequired: 'Delete the "user_id" data entry',
                },
              ],
              estimatedTransactions: 2,
              mergeReady: false,
            },
          },
        };

        const redacted = redactAuditEvent(event, salt);
        const redactedStr = JSON.stringify(redacted);

        // No raw PII should appear
        expect(redactedStr).not.toContain(accountId.substring(0, 10)); // First 10 chars
        expect(redactedStr).not.toContain(destination.substring(0, 10));
        expect(redactedStr).not.toContain(issuer.substring(0, 10));
        expect(redactedStr).not.toContain("user_id");
        expect(redactedStr).not.toContain("USDC");
        expect(redactedStr).not.toContain("1000.5");

        // But hashes and types should appear
        expect(redactedStr).toContain("accountRef");
        expect(redactedStr).toContain("destinationRef");
        expect(redactedStr).toContain("blockerTypes");
        expect(redactedStr).toContain("balance");
        expect(redactedStr).toContain("trustline");
        expect(redactedStr).toContain("data");
      });
    });
  });
});
