import { createHash } from "node:crypto";
import { z } from "zod";
import type { PolicyDefinition } from "@vela/types";

// PolicyTemplateRegistry + PolicyValidator (idea.md §6.2; §19 D3: policies
// come from structured templates, never freeform). Each template declares how
// it is ENFORCED on-chain — honestly: our configurable spending-limit contract
// (rolling-window allowance, user-chosen cap) covers spending limits; allowlists
// and thresholds map to the smart wallet's native SignerLimits; timelock awaits
// a custom contract in contracts/policy-templates.

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

/** Stroops per XLM (7 decimals). */
const STROOPS_PER_XLM = 10_000_000n;
/** Default rolling window when a policy sets only a daily cap: 24h. */
export const DEFAULT_WINDOW_SECONDS = 60 * 60 * 24;

/** Parse a decimal XLM string (e.g. "12.5") to integer stroops. Assumes the
 * value already passed `positiveDecimal` validation (digits with one dot). */
export function xlmToStroops(xlm: string): bigint {
  const [whole = "0", frac = ""] = xlm.split(".");
  const fracPadded = (frac + "0000000").slice(0, 7);
  return BigInt(whole) * STROOPS_PER_XLM + BigInt(fracPadded);
}

const address = z.string().regex(/^[GC][A-Z2-7]{55}$/, "must be a Stellar address (G… or C…)");
const contractAddress = z.string().regex(/^C[A-Z2-7]{55}$/, "must be a contract address (C…)");
const positiveDecimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .refine((v) => Number(v) > 0, {
    message: "must be a positive amount",
  });

const base = z.object({
  version: z.literal("1"),
  owners: z.array(address).min(1),
});

export type Enforcement =
  | {
      kind: "policy-contract";
      wasmHash: string;
      /** Constructor args for the per-user instance, derived from the
       * definition. Present once a spending-limit policy is generated. (Named
       * `constructorArgs`, not `constructor`, to avoid the reserved property.) */
      constructorArgs?: SpendingConstructor;
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

export interface PolicyTemplate {
  type: string;
  title: string;
  description: string;
  schema: z.ZodType;
  enforcement: Enforcement;
}

export const templates: PolicyTemplate[] = [
  {
    type: "single_owner",
    title: "Single owner",
    description: "One key controls the account (the default smart-wallet state).",
    schema: base.extend({
      type: z.literal("single_owner"),
      owners: z.array(address).length(1),
    }),
    enforcement: { kind: "none" },
  },
  {
    type: "multisig_threshold",
    title: "Multisig threshold",
    description: "Require N of M owners to approve sensitive actions.",
    schema: base
      .extend({
        type: z.literal("multisig_threshold"),
        owners: z.array(address).min(2),
        threshold: z.number().int().min(2),
      })
      .refine((v) => v.threshold <= v.owners.length, {
        message: "threshold cannot exceed the number of owners",
      }),
    enforcement: { kind: "signer-limits" },
  },
  {
    type: "spending_limit",
    title: "Spending limit",
    description: "Cap how much XLM a signer can move within a rolling window.",
    schema: base.extend({
      type: z.literal("spending_limit"),
      spendingLimits: z
        .object({
          dailyXlm: positiveDecimal.optional(),
          perTxXlm: positiveDecimal.optional(),
        })
        .refine((v) => v.dailyXlm !== undefined || v.perTxXlm !== undefined, {
          message: "set dailyXlm and/or perTxXlm",
        }),
    }),
    enforcement: { kind: "policy-contract", wasmHash: SPENDING_POLICY_WASM_HASH },
  },
  {
    type: "contract_allowlist",
    title: "Contract allowlist",
    description: "Restrict a signer to interacting only with approved contracts.",
    schema: base.extend({
      type: z.literal("contract_allowlist"),
      allowlistedContracts: z.array(contractAddress).min(1),
    }),
    enforcement: { kind: "signer-limits" },
  },
  {
    type: "timelock",
    title: "Time-lock",
    description: "Delay sensitive admin actions by a configurable period.",
    schema: base.extend({
      type: z.literal("timelock"),
      timelocks: z.object({
        adminActionDelaySeconds: z.number().int().positive(),
      }),
    }),
    enforcement: { kind: "custom-contract-pending" },
  },
];

export function getTemplate(type: string): PolicyTemplate | undefined {
  return templates.find((t) => t.type === type);
}

/**
 * Derive the on-chain constructor args for a spending-limit policy.
 *
 * The contract enforces a CUMULATIVE rolling-window allowance — a per-transfer
 * cap is not a real spending limit (policy signatures are secretless; repeated
 * capped transfers drain the wallet). So `dailyXlm` maps directly to the
 * window allowance over 24h. When only `perTxXlm` is set we still enforce it as
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

  return {
    definition,
    policyHash: policyHash(definition),
    manifest: { template: template.type, enforcement, network },
  };
}
