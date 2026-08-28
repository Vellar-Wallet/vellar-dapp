import { createHash } from "node:crypto";
import { z } from "zod";
import type { PolicyDefinition } from "@vellar/types";

// PolicyTemplateRegistry + PolicyValidator (idea.md §6.2; §19 D3: policies
// come from structured templates, never freeform). Each template declares how
// it is ENFORCED on-chain — honestly: our configurable spending-limit contract
// (cumulative allowance over a FIXED/tumbling window — resets on schedule, so up
// to 2x the cap can move across a boundary; NOT a sliding window) covers
// spending limits; allowlists and thresholds map to the smart wallet's native
// SignerLimits; timelock awaits a custom contract in contracts/policy-templates.

/**
 * VELA configurable spending-limit policy wasm (testnet). Built from
 * contracts/policy-templates/spending-limit and uploaded via stellar CLI; the
 * hash is verified against the local build (docs/decisions.md 2026-07-17).
 * Unlike the fixed-cap sample-policy, each instance takes the user's daily
 * limit + window as immutable constructor args, so the amount chosen in the
 * builder is the amount actually enforced on-chain.
 */
// Testnet wasm hash of the spending-limit policy contract. This is now the
// hash of the CANONICAL reproducible build — the bytes `stellar contract build`
// emits inside the verification toolchain image (infra/docker/…), uploaded to
// testnet 2026-07-20 (tx 6f83e098…, deployer vela-policy-deployer). So the
// deployed artifact == what the verification pipeline reproduces on any machine
// running the image (docs/decisions.md: container-as-source-of-truth). The prior
// hash (5d52e44c…) was a macOS-local build that a Linux container can't
// bit-reproduce — see the reproducibility finding in docs/decisions.md.
export const SPENDING_POLICY_WASM_HASH =
  "0f6b858d61799a33efdc2303c60eb0c148fd2983b7d2336fc345b5492a24b791";

/**
 * VELA verified-recipient policy wasm (testnet). Built through the SAME
 * canonical image (vela-verify:1.94.0), self-verified (clean rebuild
 * byte-identical), uploaded 2026-08-01 with --optimize=false (tx 4602d65e…).
 * `__constructor(wallet, registry)` binds each instance to one wallet and the
 * attestation registry; `policy__` rejects any auth whose contexts invoke a
 * contract without a live attestation (docs/design-provenance-gated-spending.md).
 */
export const VERIFIED_RECIPIENT_WASM_HASH =
  "a57efbf969d6e574e2b40d98985a145fd87d1760224ef6d10e268ea1f6080960";

/**
 * The deployed AttestationRegistry instance (testnet, 2026-08-01), fed by the
 * verification pipeline's attestor (worker-service). Baked into generated
 * verified_only manifests the same way the wasm hashes are pinned: the
 * registry an instance trusts is part of what the policy IS.
 */
export const ATTESTATION_REGISTRY_ID = "CBZVS2ETJKCIMRRWUHTZFVMWDACJNYUZ54JIXUJCHXNBFNXELKTSWHGP";

/** Stroops per XLM (7 decimals). */
const STROOPS_PER_XLM = 10_000_000n;
/** Default fixed (tumbling) window when a policy sets only a daily cap: 24h. */
export const DEFAULT_WINDOW_SECONDS = 60 * 60 * 24;

/** Parse a decimal XLM string (e.g. "12.5") to integer stroops. Assumes the
 * value already passed `positiveDecimal` validation (digits with one dot). */
export function xlmToStroops(xlm: string): bigint {
  const [whole = "0", frac = ""] = xlm.split(".");
  const fracPadded = (frac + "0000000").slice(0, 7);
  return BigInt(whole) * STROOPS_PER_XLM + BigInt(fracPadded);
}

const uniqueItems = (arr: string[]) => new Set(arr).size === arr.length;

const address = z.string().regex(/^[GC][A-Z2-7]{55}$/, "must be a Stellar address (G… or C…)");
const contractAddress = z.string().regex(/^C[A-Z2-7]{55}$/, "must be a contract address (C…)");

/**
 * Strict positive XLM decimal amount (idea.md §6.2).
 * Enforces Stellar stroop precision (max 7 decimal places) and positive value (>= 1 stroop = 0.0000001 XLM).
 */
const positiveXlmAmount = z
  .string()
  .regex(/^\d+(\.\d{1,7})?$/, "must be a valid decimal amount with at most 7 decimal places")
  .refine(
    (v) => {
      try {
        return xlmToStroops(v) > 0n;
      } catch {
        return false;
      }
    },
    { message: "amount must be at least 1 stroop (0.0000001 XLM)" },
  );

const base = z.object({
  version: z.literal("1"),
  owners: z
    .array(address)
    .min(1, "must have at least one owner")
    .refine(uniqueItems, { message: "duplicate owners are not allowed" }),
});

export type Enforcement =
  | {
      kind: "policy-contract";
      wasmHash: string;
      /** Constructor args for the per-user instance, derived from the
       * definition/deployment. Present once a policy is generated. (Named
       * `constructorArgs`, not `constructor`, to avoid the reserved property.) */
      constructorArgs?: SpendingConstructor | VerifiedRecipientConstructor;
    }
  | { kind: "signer-limits" }
  | { kind: "none" }
  | { kind: "custom-contract-pending" };

/** Immutable args passed to the spending-limit contract's `__constructor`.
 * `wallet` is filled in at deploy time (the user's smart-account address); the
 * amount/window come from the policy definition. */
export interface SpendingConstructor {
  dailyLimitStroops: string;
  windowSeconds: number;
}

/** Immutable args for the verified-recipient contract's `__constructor`.
 * `wallet` is filled in at deploy time; the registry is pinned at generate
 * time (ATTESTATION_REGISTRY_ID). */
export interface VerifiedRecipientConstructor {
  registry: string;
}

export interface PolicyTemplate {
  type: string;
  title: string;
  description: string;
  schema: z.ZodType;
  enforcement: Enforcement;
}

/**
 * Schema validation rules for spending limits (idea.md §6.2):
 * - At least one of dailyXlm or perTxXlm must be provided
 * - Amounts must have <= 7 decimals and >= 1 stroop
 * - If both are set, perTxXlm must not exceed dailyXlm
 */
const spendingLimitsSchema = z
  .object({
    dailyXlm: positiveXlmAmount.optional(),
    perTxXlm: positiveXlmAmount.optional(),
  })
  .strict()
  .refine((v) => v.dailyXlm !== undefined || v.perTxXlm !== undefined, {
    message: "set dailyXlm and/or perTxXlm",
  })
  .refine(
    (v) => {
      if (v.dailyXlm !== undefined && v.perTxXlm !== undefined) {
        return xlmToStroops(v.perTxXlm) <= xlmToStroops(v.dailyXlm);
      }
      return true;
    },
    { message: "perTxXlm cannot exceed dailyXlm" },
  );

/**
 * Policy templates registry with strict field-level schema validation (idea.md §6.2).
 * Every template strictly validates input fields, range limits, unique arrays, and rejects unexpected properties.
 */
export const templates: PolicyTemplate[] = [
  {
    type: "single_owner",
    title: "Single owner",
    description: "One key controls the account (the default smart-wallet state).",
    schema: base
      .extend({
        type: z.literal("single_owner"),
        owners: z
          .array(address)
          .length(1, "single_owner policy requires exactly one owner")
          .refine(uniqueItems, { message: "duplicate owners are not allowed" }),
      })
      .strict(),
    enforcement: { kind: "none" },
  },
  {
    type: "multisig_threshold",
    title: "Multisig threshold",
    description: "Require N of M owners to approve sensitive actions.",
    schema: base
      .extend({
        type: z.literal("multisig_threshold"),
        owners: z
          .array(address)
          .min(2, "multisig_threshold policy requires at least two owners")
          .refine(uniqueItems, { message: "duplicate owners are not allowed" }),
        threshold: z
          .number()
          .int("threshold must be an integer")
          .min(2, "threshold must be at least 2"),
      })
      .strict()
      .refine((v) => v.threshold <= v.owners.length, {
        message: "threshold cannot exceed the number of owners",
      }),
    enforcement: { kind: "signer-limits" },
  },
  {
    type: "spending_limit",
    title: "Spending limit",
    description: "Cap total XLM a signer can move per fixed period.",
    schema: base
      .extend({
        type: z.literal("spending_limit"),
        spendingLimits: spendingLimitsSchema,
      })
      .strict(),
    enforcement: { kind: "policy-contract", wasmHash: SPENDING_POLICY_WASM_HASH },
  },
  {
    type: "contract_allowlist",
    title: "Contract allowlist",
    description: "Restrict a signer to interacting only with approved contracts.",
    schema: base
      .extend({
        type: z.literal("contract_allowlist"),
        allowlistedContracts: z
          .array(contractAddress)
          .min(1, "must allowlist at least one contract")
          .refine(uniqueItems, { message: "duplicate allowlisted contracts are not allowed" }),
      })
      .strict(),
    enforcement: { kind: "signer-limits" },
  },
  {
    type: "verified_only",
    title: "Verified contracts only",
    description: "Restrict a signer to contracts with verified source.",
    schema: base
      .extend({
        type: z.literal("verified_only"),
      })
      .strict(),
    enforcement: { kind: "policy-contract", wasmHash: VERIFIED_RECIPIENT_WASM_HASH },
  },
  {
    type: "timelock",
    title: "Time-lock",
    description: "Delay sensitive admin actions by a configurable period.",
    schema: base
      .extend({
        type: z.literal("timelock"),
        timelocks: z
          .object({
            adminActionDelaySeconds: z
              .number()
              .int("delay must be an integer")
              .min(1, "delay must be at least 1 second")
              .max(31_536_000, "delay cannot exceed 31,536,000 seconds (365 days)"),
          })
          .strict(),
      })
      .strict(),
    enforcement: { kind: "custom-contract-pending" },
  },
];

export function getTemplate(type: string): PolicyTemplate | undefined {
  return templates.find((t) => t.type === type);
}

/**
 * Derive the on-chain constructor args for a spending-limit policy.
 *
 * The contract enforces a CUMULATIVE allowance over a FIXED (tumbling) window —
 * a per-transfer cap is not a real spending limit (policy signatures are
 * secretless; repeated capped transfers drain the wallet). So `dailyXlm` maps
 * directly to the window allowance over 24h (resets on a fixed schedule, so up
 * to 2x can move across a boundary). When only `perTxXlm` is set we still enforce it as
 * a cumulative daily cap (the safe interpretation), never as an unbounded
 * per-tx cap. When both are set, the daily cap is the enforced ceiling and the
 * per-tx value is authoring metadata only.
 */
export function deriveSpendingConstructor(definition: PolicyDefinition): SpendingConstructor {
  const limits = (definition as { spendingLimits?: { dailyXlm?: string; perTxXlm?: string } })
    .spendingLimits;
  const capXlm = limits?.dailyXlm ?? limits?.perTxXlm;
  if (!capXlm) {
    // Unreachable for a validated spending_limit definition (the schema
    // requires at least one), but fail loud rather than deploy an empty cap.
    throw new Error("spending_limit policy has no dailyXlm or perTxXlm");
  }
  return {
    dailyLimitStroops: xlmToStroops(capXlm).toString(),
    windowSeconds: DEFAULT_WINDOW_SECONDS,
  };
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateDefinition(definition: unknown): ValidationResult {
  const typed = definition as { type?: unknown };
  const template = typeof typed?.type === "string" ? getTemplate(typed.type) : undefined;
  if (!template) {
    return { valid: false, errors: [`unknown policy type: ${String(typed?.type)}`] };
  }
  const parsed = template.schema.safeParse(definition);
  if (parsed.success) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: parsed.error.issues.map((i) => `${i.path.join(".") || "definition"}: ${i.message}`),
  };
}

/** Recursive key-sorted serialization — a replacer array would silently drop
 * nested keys, making the hash blind to policy content. */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Deterministic content hash (idea.md §6.2 output artifacts: policy hash). */
export function policyHash(definition: PolicyDefinition): string {
  return createHash("sha256").update(canonicalize(definition)).digest("hex");
}

export interface GeneratedPolicy {
  definition: PolicyDefinition;
  policyHash: string;
  /** Deployment manifest (idea.md §6.2): how this policy gets enforced. */
  manifest: {
    template: string;
    enforcement: Enforcement;
    network: "testnet" | "mainnet";
  };
}

export function generatePolicy(
  definition: PolicyDefinition,
  network: "testnet" | "mainnet",
): GeneratedPolicy {
  const template = getTemplate(definition.type);
  if (!template) throw new Error(`unknown policy type: ${definition.type}`);

  // Spending limits deploy a policy contract instance; bake the per-user
  // constructor args (derived from THIS definition) into the manifest so the
  // deploy step is a pure function of the generated policy.
  let enforcement = template.enforcement;
  if (definition.type === "spending_limit" && enforcement.kind === "policy-contract") {
    enforcement = { ...enforcement, constructorArgs: deriveSpendingConstructor(definition) };
  }
  // Verified-only instances bind to the deployed attestation registry — pinned
  // at generate time so the manifest fully determines the deploy.
  if (definition.type === "verified_only" && enforcement.kind === "policy-contract") {
    enforcement = { ...enforcement, constructorArgs: { registry: ATTESTATION_REGISTRY_ID } };
  }

  return {
    definition,
    policyHash: policyHash(definition),
    manifest: { template: template.type, enforcement, network },
  };
}
