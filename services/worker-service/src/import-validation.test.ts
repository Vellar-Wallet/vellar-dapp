import { describe, expect, it } from "vitest";
import { validateImportedRecord, toClaimedJob } from "./import-validation";

// Canonical valid contract addresses for tests (Soroban C…, 56 chars total).
const C1 = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";
const C2 = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
// A classic G-address — must be rejected everywhere contractId is validated.
const G1 = "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM";

/** A fully valid repo record that every test can spread from. */
const validRepo = {
  id: "rec-001",
  contractId: C1,
  sourceType: "repo" as const,
  repoUrl: "https://github.com/example/contract",
  commitHash: "a1b2c3d",
  toolchainVersion: "1.81.0",
  buildFlags: ["--release"],
  status: "submitted" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** A fully valid upload record. */
const validUpload = {
  id: "rec-002",
  contractId: C2,
  sourceType: "upload" as const,
  sourceArchiveRef: "archive://abc123",
  toolchainVersion: "1.81.0",
  status: "submitted" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(raw: unknown) {
  const result = validateImportedRecord(raw);
  expect(result.ok, `expected ok but got: ${!result.ok ? (result as { reason: string }).reason : ""}`).toBe(true);
  return result;
}

function fail(raw: unknown) {
  const result = validateImportedRecord(raw);
  expect(result.ok).toBe(false);
  // Never throws — always a RecordValidationFail when ok=false.
  return result as { ok: false; reason: string };
}

// ── Valid records ─────────────────────────────────────────────────────────────

describe("validateImportedRecord — valid records", () => {
  it("accepts a fully valid repo record", () => {
    const result = ok(validRepo);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.contractId).toBe(C1);
      expect(result.record.sourceType).toBe("repo");
    }
  });

  it("accepts a fully valid upload record", () => {
    const result = ok(validUpload);
    expect(result.ok).toBe(true);
  });

  it("accepts optional fields when present and valid", () => {
    const result = ok({
      ...validRepo,
      lockfileHash: "deadbeef",
      outputHash: "a".repeat(64),
      deployedHash: "b".repeat(64),
      log: "build log",
      statusDetail: "Verified.",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts all terminal status values", () => {
    for (const status of ["verified", "failed", "building", "dead_letter"] as const) {
      const result = ok({ ...validRepo, status });
      expect(result.ok).toBe(true);
    }
  });

  it("accepts a full commit sha (40 hex chars)", () => {
    const result = ok({ ...validRepo, commitHash: "a".repeat(40) });
    expect(result.ok).toBe(true);
  });

  it("ignores unknown extra fields (forward-compatible with new jsonb keys)", () => {
    // .strict() is intentionally not used — new optional fields added in future
    // migrations must not break existing workers.
    const result = ok({ ...validRepo, _futureField: "some-value", attempts: 2 });
    expect(result.ok).toBe(true);
  });

  it("accepts updatedAt equal to createdAt", () => {
    const result = ok({
      ...validRepo,
      createdAt: "2026-06-01T12:00:00.000Z",
      updatedAt: "2026-06-01T12:00:00.000Z",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts updatedAt strictly after createdAt", () => {
    const result = ok({
      ...validRepo,
      createdAt: "2026-06-01T12:00:00.000Z",
      updatedAt: "2026-06-01T13:00:00.000Z",
    });
    expect(result.ok).toBe(true);
  });
});

// ── Missing required fields ───────────────────────────────────────────────────

describe("validateImportedRecord — missing required fields", () => {
  it("rejects when id is missing", () => {
    const { id: _omit, ...noId } = validRepo;
    const result = fail(noId);
    expect(result.reason).toContain("id");
  });

  it("rejects when contractId is missing", () => {
    const { contractId: _omit, ...noContract } = validRepo;
    const result = fail(noContract);
    expect(result.reason).toContain("contractId");
  });

  it("rejects when sourceType is missing", () => {
    const { sourceType: _omit, ...noSource } = validRepo;
    const result = fail(noSource);
    expect(result.reason).toContain("sourceType");
  });

  it("rejects when toolchainVersion is missing", () => {
    const { toolchainVersion: _omit, ...noToolchain } = validRepo;
    const result = fail(noToolchain);
    expect(result.reason).toContain("toolchainVersion");
  });

  it("rejects when status is missing", () => {
    const { status: _omit, ...noStatus } = validRepo;
    const result = fail(noStatus);
    expect(result.reason).toContain("status");
  });

  it("rejects when createdAt is missing", () => {
    const { createdAt: _omit, ...noCreated } = validRepo;
    const result = fail(noCreated);
    expect(result.reason).toContain("createdAt");
  });

  it("rejects when updatedAt is missing", () => {
    const { updatedAt: _omit, ...noUpdated } = validRepo;
    const result = fail(noUpdated);
    expect(result.reason).toContain("updatedAt");
  });

  it("rejects a repo record missing repoUrl", () => {
    const { repoUrl: _omit, ...noUrl } = validRepo;
    const result = fail(noUrl);
    expect(result.reason).toContain("repoUrl");
  });

  it("rejects a repo record missing commitHash", () => {
    const { commitHash: _omit, ...noCommit } = validRepo;
    const result = fail(noCommit);
    expect(result.reason).toContain("commitHash");
  });

  it("rejects an upload record missing sourceArchiveRef", () => {
    const { sourceArchiveRef: _omit, ...noArchive } = validUpload;
    const result = fail(noArchive);
    expect(result.reason).toContain("sourceArchiveRef");
  });

  it("rejects an empty string id", () => {
    const result = fail({ ...validRepo, id: "" });
    expect(result.reason).toContain("id");
  });

  it("rejects an empty string toolchainVersion", () => {
    const result = fail({ ...validRepo, toolchainVersion: "" });
    expect(result.reason).toContain("toolchainVersion");
  });

  it("reports all failing fields in a single reason string", () => {
    // Both contractId and toolchainVersion are invalid — both must appear.
    const result = fail({ ...validRepo, contractId: "bad", toolchainVersion: "" });
    expect(result.reason).toContain("contractId");
    expect(result.reason).toContain("toolchainVersion");
  });
});

// ── Wrong types ───────────────────────────────────────────────────────────────

describe("validateImportedRecord — wrong types", () => {
  it("rejects a non-string contractId", () => {
    const result = fail({ ...validRepo, contractId: 12345 });
    expect(result.reason).toContain("contractId");
  });

  it("rejects a non-string toolchainVersion", () => {
    const result = fail({ ...validRepo, toolchainVersion: true });
    expect(result.reason).toContain("toolchainVersion");
  });

  it("rejects an invalid sourceType (not 'repo' or 'upload')", () => {
    const result = fail({ ...validRepo, sourceType: "git" });
    expect(result.reason).toContain("sourceType");
  });

  it("rejects an invalid status value", () => {
    const result = fail({ ...validRepo, status: "pending" });
    expect(result.reason).toContain("status");
  });

  it("rejects buildFlags that is not an array", () => {
    const result = fail({ ...validRepo, buildFlags: "--release" });
    expect(result.reason).toContain("buildFlags");
  });

  it("rejects buildFlags containing a non-string element", () => {
    const result = fail({ ...validRepo, buildFlags: ["--release", 42] });
    expect(result.reason).toContain("buildFlags");
  });

  it("rejects a non-string createdAt", () => {
    const result = fail({ ...validRepo, createdAt: 1_700_000_000 });
    expect(result.reason).toContain("createdAt");
  });

  it("rejects a completely non-object payload (string)", () => {
    const result = fail("not an object");
    expect(result.ok).toBe(false);
  });

  it("rejects null", () => {
    const result = fail(null);
    expect(result.ok).toBe(false);
  });
});

// ── Malformed contractId ──────────────────────────────────────────────────────

describe("validateImportedRecord — malformed contractId", () => {
  it("rejects a classic G-address", () => {
    const result = fail({ ...validRepo, contractId: G1 });
    expect(result.reason).toContain("contractId");
    expect(result.reason).toContain("C\u2026"); // the error message says C…
  });

  it("rejects a contractId that is too short", () => {
    const result = fail({ ...validRepo, contractId: "CABC123" });
    expect(result.reason).toContain("contractId");
  });

  it("rejects a contractId with lowercase characters", () => {
    // strkeys are uppercase-only; lowercase is not valid base32
    const result = fail({ ...validRepo, contractId: "c" + "A".repeat(55) });
    expect(result.reason).toContain("contractId");
  });

  it("rejects a contractId with an invalid leading character (not C)", () => {
    const result = fail({ ...validRepo, contractId: "B" + "A".repeat(55) });
    expect(result.reason).toContain("contractId");
  });

  it("rejects a contractId containing invalid base32 characters (0, 1, 8, 9)", () => {
    // Base32 alphabet is A–Z and 2–7 only; 0/1/8/9 are invalid
    const result = fail({ ...validRepo, contractId: "C" + "0".repeat(55) });
    expect(result.reason).toContain("contractId");
  });
});

// ── Timestamp validation ──────────────────────────────────────────────────────

describe("validateImportedRecord — timestamp rules", () => {
  it("rejects a non-parseable createdAt string", () => {
    const result = fail({ ...validRepo, createdAt: "not-a-date" });
    expect(result.reason).toContain("createdAt");
  });

  it("rejects a non-parseable updatedAt string", () => {
    const result = fail({ ...validRepo, updatedAt: "not-a-date" });
    expect(result.reason).toContain("updatedAt");
  });

  it("rejects updatedAt earlier than createdAt", () => {
    const result = fail({
      ...validRepo,
      createdAt: "2026-06-01T12:00:00.000Z",
      updatedAt: "2026-05-01T12:00:00.000Z", // one month before createdAt
    });
    expect(result.reason).toContain("updatedAt");
    expect(result.reason).toContain("greater than or equal to createdAt");
  });
});

// ── Optional wasm hash validation ─────────────────────────────────────────────

describe("validateImportedRecord — optional wasm hash format", () => {
  it("rejects an outputHash that is not 64 lowercase hex chars", () => {
    const result = fail({ ...validRepo, outputHash: "0xDEADBEEF" });
    expect(result.reason).toContain("outputHash");
  });

  it("rejects a deployedHash with uppercase characters", () => {
    const result = fail({ ...validRepo, deployedHash: "A".repeat(64) });
    expect(result.reason).toContain("deployedHash");
  });

  it("rejects a deployedHash that is too short", () => {
    const result = fail({ ...validRepo, deployedHash: "a".repeat(32) });
    expect(result.reason).toContain("deployedHash");
  });
});

// ── commitHash validation ─────────────────────────────────────────────────────

describe("validateImportedRecord — commitHash format", () => {
  it("rejects a commitHash shorter than 7 characters", () => {
    const result = fail({ ...validRepo, commitHash: "abc12" });
    expect(result.reason).toContain("commitHash");
  });

  it("rejects a commitHash with non-hex characters", () => {
    const result = fail({ ...validRepo, commitHash: "zzzzzzzz" });
    expect(result.reason).toContain("commitHash");
  });

  it("rejects a commitHash longer than 40 characters", () => {
    const result = fail({ ...validRepo, commitHash: "a".repeat(41) });
    expect(result.reason).toContain("commitHash");
  });
});

// ── toClaimedJob mapping ──────────────────────────────────────────────────────

describe("toClaimedJob", () => {
  it("maps a validated repo record to the correct ClaimedJob shape", () => {
    const result = validateImportedRecord(validRepo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const job = toClaimedJob(result.record, 1_700_000_000_000);
    expect(job.recordId).toBe("rec-001");
    expect(job.contractId).toBe(C1);
    expect(job.sourceType).toBe("repo");
    expect(job.repoUrl).toBe("https://github.com/example/contract");
    expect(job.commitHash).toBe("a1b2c3d");
    expect(job.toolchainVersion).toBe("1.81.0");
    expect(job.buildFlags).toEqual(["--release"]);
    expect(job.submittedAtMs).toBe(1_700_000_000_000);
  });

  it("maps a validated upload record correctly", () => {
    const result = validateImportedRecord(validUpload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const job = toClaimedJob(result.record);
    expect(job.recordId).toBe("rec-002");
    expect(job.sourceType).toBe("upload");
    expect(job.sourceArchiveRef).toBe("archive://abc123");
    expect(job.repoUrl).toBeUndefined();
    expect(job.commitHash).toBeUndefined();
    expect(job.submittedAtMs).toBeUndefined();
  });
});

// ── Mixed batch (integration-level unit test on the validator) ────────────────

describe("validateImportedRecord — mixed batch simulation", () => {
  it("only valid records pass through; each invalid one has a specific reason", () => {
    const batch: unknown[] = [
      validRepo,                                             // valid
      { ...validRepo, id: "bad-1", contractId: G1 },        // bad contractId
      { ...validRepo, id: "bad-2", toolchainVersion: "" },  // empty toolchain
      { ...validUpload, id: "rec-003" },                     // valid upload
      { ...validRepo, id: "bad-3", status: "unknown" },     // bad status enum
      { ...validRepo, id: "bad-4", commitHash: "zz" },      // bad commitHash
    ];

    const valid: string[] = [];
    const rejected: Array<{ id: string; reason: string }> = [];

    for (const raw of batch) {
      const result = validateImportedRecord(raw);
      if (result.ok) {
        valid.push(result.record.id);
      } else {
        // Extract id from the raw object for logging (may be absent/invalid).
        const id = (raw && typeof raw === "object" && "id" in raw)
          ? String((raw as Record<string, unknown>).id)
          : "(unknown)";
        rejected.push({ id, reason: result.reason });
      }
    }

    // Exactly the two valid records pass.
    expect(valid).toEqual(["rec-001", "rec-003"]);
    expect(rejected).toHaveLength(4);

    // Each rejection carries a specific, field-named reason.
    const find = (id: string) => rejected.find((r) => r.id === id)!;

    expect(find("bad-1").reason).toContain("contractId");
    expect(find("bad-2").reason).toContain("toolchainVersion");
    expect(find("bad-3").reason).toContain("status");
    expect(find("bad-4").reason).toContain("commitHash");
  });
});
