import { z } from "zod";
import type { VerificationRecordInternal } from "@vellar/verification-service/server";
import type { ClaimedJob } from "./job-store";

// Import-validation (issue #346): every record claimed from the store is passed
// through this schema before it reaches runVerification.  The worker reads
// rows from a jsonb column written by verification-service; if a row is
// malformed (bad migration, external tool, or a future ingestion path that
// skips the HTTP-layer Zod check) it must be rejected here — not handed to the
// build executor or the RPC resolver, where downstream errors would be opaque.
//
// Validation rules mirror the verification-service submitBodySchema exactly,
// extended with the fields the worker also requires (id, status, timestamps).
// We reuse the same Zod version (^4.0.0) that verification-service already
// depends on — no new library introduced.

// ── Field-level primitives ────────────────────────────────────────────────────

// A Soroban contract address: starts with C, followed by exactly 55 uppercase
// base32 characters.  Classic G-addresses and anything else are rejected.
const contractIdSchema = z
  .string()
  .regex(/^C[A-Z2-7]{55}$/, "must be a deployed Soroban contract address (C…)");

// A git commit sha: 7–40 hex characters (short or full sha).
const commitHashSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{7,40}$/, "must be a git commit sha (7–40 hex characters)");

// A wasm hash: exactly 64 lowercase hex characters (sha256).  Only validated
// when present; the worker populates these itself on terminal records.
const wasmHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be a lowercase hex sha256 (64 characters)");

// An ISO 8601 timestamp string.  z.iso.datetime() requires the full form with
// timezone offset; we also accept the simpler datetime() which just checks
// that the string parses to a valid date via coerce — use a manual refinement
// so the error message is clear.
const isoTimestampSchema = z
  .string()
  .refine((v) => Number.isFinite(Date.parse(v)), "must be a valid ISO 8601 timestamp");

// The full set of status values a row may legitimately carry (from @vellar/types
// VerificationStatus — keep in sync).
const verificationStatusSchema = z.enum([
  "unverified",
  "submitted",
  "building",
  "verified",
  "failed",
  "dead_letter",
]);

// ── Full record schema ────────────────────────────────────────────────────────

/**
 * Zod schema for a VerificationRecordInternal row as it arrives from the
 * database jsonb column.  Only fields the worker actually uses are required;
 * optional fields are validated only when present.
 *
 * Strict mode (.strict()) is intentionally NOT used here: the jsonb column may
 * grow new optional fields in future migrations and the worker should not break
 * on unknown keys — it simply ignores them.
 */
export const importedRecordSchema = z
  .object({
    // ── Identity ──────────────────────────────────────────────────────────────
    id: z.string().min(1, "id must be a non-empty string"),
    contractId: contractIdSchema,

    // ── Source type + conditional fields ─────────────────────────────────────
    sourceType: z.enum(["repo", "upload"]),
    repoUrl: z.string().url("repoUrl must be a valid URL").optional(),
    commitHash: commitHashSchema.optional(),
    sourceArchiveRef: z.string().min(1, "sourceArchiveRef must not be empty").optional(),

    // ── Build inputs ─────────────────────────────────────────────────────────
    toolchainVersion: z.string().min(1, "toolchainVersion must be a non-empty string"),
    buildFlags: z.array(z.string()).optional(),
    lockfileHash: z.string().min(1, "lockfileHash must not be empty if present").optional(),

    // ── Worker-populated result fields (optional — absent on submitted rows) ──
    outputHash: wasmHashSchema.optional(),
    deployedHash: wasmHashSchema.optional(),
    log: z.string().optional(),
    statusDetail: z.string().optional(),

    // ── Status ────────────────────────────────────────────────────────────────
    status: verificationStatusSchema,

    // ── Timestamps ────────────────────────────────────────────────────────────
    // Both must be valid ISO 8601.  updatedAt must be ≥ createdAt (a row cannot
    // be updated before it was created).
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  // ── Cross-field invariants ────────────────────────────────────────────────
  .superRefine((val, ctx) => {
    // repo submissions must carry both repoUrl and commitHash.
    if (val.sourceType === "repo") {
      if (!val.repoUrl) {
        ctx.addIssue({
          code: "custom",
          path: ["repoUrl"],
          message: "repoUrl is required for repo submissions",
        });
      }
      if (!val.commitHash) {
        ctx.addIssue({
          code: "custom",
          path: ["commitHash"],
          message: "commitHash is required for repo submissions",
        });
      }
    }
    // upload submissions must carry a sourceArchiveRef.
    if (val.sourceType === "upload" && !val.sourceArchiveRef) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceArchiveRef"],
        message: "sourceArchiveRef is required for upload submissions",
      });
    }
    // updatedAt must not pre-date createdAt.
    if (Date.parse(val.updatedAt) < Date.parse(val.createdAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "updatedAt must be greater than or equal to createdAt",
      });
    }
  });

export type ImportedRecord = z.infer<typeof importedRecordSchema>;

// ── Validation result ─────────────────────────────────────────────────────────

export interface RecordValidationOk {
  ok: true;
  record: ImportedRecord;
}

export interface RecordValidationFail {
  ok: false;
  /** A structured, operator-readable reason string: lists every failing field
   * and its specific message so log consumers can act without digging into raw
   * Zod output. */
  reason: string;
}

export type RecordValidationResult = RecordValidationOk | RecordValidationFail;

/**
 * Validates a raw jsonb value claimed from the database against the full
 * import schema.
 *
 * Returns `{ ok: true, record }` on success or `{ ok: false, reason }` on
 * failure.  `reason` names every failing field and why, e.g.:
 *   "contractId: must be a deployed Soroban contract address (C…); toolchainVersion: must be a non-empty string"
 *
 * Never throws — all Zod errors are captured and surfaced through the result.
 */
export function validateImportedRecord(raw: unknown): RecordValidationResult {
  const result = importedRecordSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, record: result.data };
  }
  // Collapse the Zod issue list into a single human-readable string.
  // Format: "field.path: message; field.path: message"
  const reason = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return { ok: false, reason };
}

/**
 * Maps a validated ImportedRecord to the ClaimedJob shape the worker loop
 * expects.  Call only after validateImportedRecord returns ok=true.
 */
export function toClaimedJob(record: ImportedRecord, submittedAtMs?: number): ClaimedJob {
  return {
    recordId: record.id,
    contractId: record.contractId,
    sourceType: record.sourceType,
    repoUrl: record.repoUrl,
    commitHash: record.commitHash,
    sourceArchiveRef: record.sourceArchiveRef,
    toolchainVersion: record.toolchainVersion,
    buildFlags: record.buildFlags,
    submittedAtMs,
  };
}
