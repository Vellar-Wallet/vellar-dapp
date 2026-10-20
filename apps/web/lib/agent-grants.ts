import { StrKey } from "@stellar/stellar-sdk";
import type { AgentPolicyGrant } from "vellar-sdk";

// Verified-only agent spending (issue #406; docs/design-phase8-payments.md).
//
// Decision: an agent key may NOT transact through unverified contracts unless
// the human explicitly opted that key out at mint time. Enforcement is
// on-chain: the verified-recipient policy is a REQUIRED CO-SIGNER in every
// grant of the agent key's SignerLimits, so the wallet's __check_auth runs it
// (against the attestation registry) on each context the agent authorizes.
// This module only builds that grant list for wallet.agents.mint — it decides
// nothing at payment time and is not itself the enforcement.
//
// Honesty bar: verified ≠ safe. "Verified" means the contract has
// reproducible, attributable source provenance per the attestation registry —
// not that it is audited, benign, or that the seller behind a payment is
// trustworthy. The gate checks the CONTRACTS the agent's auth entries invoke
// (e.g. the token in a transfer), not the human/G-account receiving funds.

export type AgentVerificationMode =
  { mode: "verified-only"; verifiedOnlyPolicy: string } | { mode: "unrestricted"; reason: string };

export type SpendableBalanceInput =
  | Record<string, bigint | string>
  | ReadonlyArray<{ token: string; spendable: bigint | string; symbol?: string }>
  | Map<string, bigint | string>;

export interface GrantBudgetLimit {
  /** Requested grant budget in the token's base units. */
  amountBaseUnits: bigint | string;
  /** Optional human-readable symbol for diagnostics (e.g. "USDC", "XLM"). */
  symbol?: string;
}

export interface AgentGrantInput {
  /** Token contract (C…) -> the spending-limit policy instance(s) budgeting it. */
  budgets: Record<string, string[]>;
  verification: AgentVerificationMode;
  /**
   * Optional per-token requested budget amounts (in base units) to validate
   * against the wallet's current spendable balances at mint time (#562).
   */
  budgetAmounts?: Record<string, bigint | string | GrantBudgetLimit>;
  /**
   * Wallet's current spendable balances per token contract (C…) in base units.
   * Each token's grant budget is checked against that specific token's
   * spendable balance (never the native XLM balance when budgeting another token).
   */
  spendableBalances?: SpendableBalanceInput;
}

/** What the human approved, for the audit trail and the approval screen. */
export interface AgentTrustDecision {
  mode: AgentVerificationMode["mode"];
  tokens: string[];
  verifiedOnlyPolicy?: string;
  /** Required and non-empty for "unrestricted": the override is never implicit. */
  reason?: string;
}

export class AgentGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentGrantError";
  }
}

export class AgentGrantBalanceError extends AgentGrantError {
  readonly code = "grant_exceeds_spendable_balance" as const;
  readonly token: string;
  readonly requested: bigint;
  readonly spendable: bigint;

  constructor(token: string, requested: bigint, spendable: bigint, symbol?: string) {
    const label = symbol ? `${symbol} (${token})` : token;
    super(
      `Agent grant budget (${requested.toString()} base units) for ${label} exceeds the wallet's current spendable balance (${spendable.toString()} base units) at mint time.`,
    );
    this.name = "AgentGrantBalanceError";
    this.token = token;
    this.requested = requested;
    this.spendable = spendable;
  }
}

const MAX_REASON_LENGTH = 200;

function assertContract(id: string, what: string): void {
  if (!StrKey.isValidContract(id))
    throw new AgentGrantError(`${what} must be a contract address (C…).`);
}

function parseNonNegativeUnits(value: bigint | string, what: string): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new AgentGrantError(`${what} must be an integer base-unit amount.`);
    }
    parsed = BigInt(trimmed);
  }
  return parsed < 0n ? 0n : parsed;
}

function parsePositiveBudgetUnits(
  entry: bigint | string | GrantBudgetLimit,
  token: string,
): { requested: bigint; symbol?: string } {
  const raw =
    typeof entry === "object" && entry !== null && "amountBaseUnits" in entry
      ? entry.amountBaseUnits
      : entry;
  const symbol =
    typeof entry === "object" && entry !== null && "symbol" in entry ? entry.symbol : undefined;

  let parsed: bigint;
  if (typeof raw === "bigint") {
    parsed = raw;
  } else {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new AgentGrantError(`Grant budget for ${token} must be a positive base-unit integer.`);
    }
    parsed = BigInt(trimmed);
  }
  if (parsed <= 0n) {
    throw new AgentGrantError(`Grant budget for ${token} must be greater than zero.`);
  }
  return { requested: parsed, ...(symbol ? { symbol } : {}) };
}

function normalizeSpendableBalances(
  input: SpendableBalanceInput,
): Map<string, { spendable: bigint; symbol?: string }> {
  const map = new Map<string, { spendable: bigint; symbol?: string }>();
  if (input instanceof Map) {
    for (const [token, val] of input.entries()) {
      map.set(token, { spendable: parseNonNegativeUnits(val, `Spendable balance for ${token}`) });
    }
    return map;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      map.set(item.token, {
        spendable: parseNonNegativeUnits(item.spendable, `Spendable balance for ${item.token}`),
        ...(item.symbol ? { symbol: item.symbol } : {}),
      });
    }
    return map;
  }
  for (const [token, val] of Object.entries(input as Record<string, bigint | string>)) {
    map.set(token, { spendable: parseNonNegativeUnits(val, `Spendable balance for ${token}`) });
  }
  return map;
}

/**
 * Validate that every requested agent grant budget is within the wallet's
 * current spendable balance for that specific token at mint time (#562).
 * Throws `AgentGrantBalanceError` (a subclass of `AgentGrantError`) before any
 * passkey signing can proceed if any token's budget exceeds its spendable balance.
 */
export function validateGrantBudgetsAgainstBalances(
  budgetAmounts: Record<string, bigint | string | GrantBudgetLimit>,
  spendableBalances: SpendableBalanceInput,
): void {
  const balances = normalizeSpendableBalances(spendableBalances);
  for (const [token, rawBudget] of Object.entries(budgetAmounts)) {
    assertContract(token, "Each token");
    const { requested, symbol } = parsePositiveBudgetUnits(rawBudget, token);
    const balanceEntry = balances.get(token);
    const spendable = balanceEntry?.spendable ?? 0n;
    const resolvedSymbol = symbol ?? balanceEntry?.symbol;
    if (requested > spendable) {
      throw new AgentGrantBalanceError(token, requested, spendable, resolvedSymbol);
    }
  }
}

export function buildAgentGrants(input: AgentGrantInput): {
  grants: AgentPolicyGrant[];
  decision: AgentTrustDecision;
} {
  const tokens = Object.keys(input.budgets);
  if (tokens.length === 0) throw new AgentGrantError("Grant the agent at least one token.");

  const v = input.verification;
  if (v.mode === "verified-only") {
    assertContract(v.verifiedOnlyPolicy, "The verified-only policy");
  } else {
    const reason = v.reason.trim();
    if (!reason) {
      throw new AgentGrantError("Turning off verified-only spending needs a stated reason.");
    }
    if (reason.length > MAX_REASON_LENGTH) {
      throw new AgentGrantError(`Keep the reason under ${MAX_REASON_LENGTH} characters.`);
    }
  }

  if (input.budgetAmounts !== undefined || input.spendableBalances !== undefined) {
    if (!input.budgetAmounts || !input.spendableBalances) {
      throw new AgentGrantError(
        "Both budgetAmounts and spendableBalances are required to check spendable balances at mint time.",
      );
    }
    for (const token of tokens) {
      assertContract(token, "Each token");
      if (!(token in input.budgetAmounts)) {
        throw new AgentGrantError(`Missing budget amount for token ${token}.`);
      }
    }
    validateGrantBudgetsAgainstBalances(input.budgetAmounts, input.spendableBalances);
  }

  const grants = tokens.map((token) => {
    assertContract(token, "Each token");
    const budget = [...new Set(input.budgets[token] ?? [])];
    // A budget is mandatory: a grant whose only co-signer is the verified-only
    // policy would let the agent spend without limit through verified tokens.
    if (budget.length === 0) {
      throw new AgentGrantError("Every token needs a spending-limit policy.");
    }
    budget.forEach((p) => assertContract(p, "Each spending policy"));
    if (v.mode === "verified-only" && budget.includes(v.verifiedOnlyPolicy)) {
      throw new AgentGrantError("The verified-only policy can't double as a spending limit.");
    }
    return {
      token,
      policies: v.mode === "verified-only" ? [...budget, v.verifiedOnlyPolicy] : budget,
    };
  });

  const decision: AgentTrustDecision =
    v.mode === "verified-only"
      ? { mode: v.mode, tokens, verifiedOnlyPolicy: v.verifiedOnlyPolicy }
      : { mode: v.mode, tokens, reason: v.reason.trim() };
  return { grants, decision };
}

/** Approval-screen copy for the decision. Never claims "safe". */
export function describeAgentTrust(decision: AgentTrustDecision): string {
  if (decision.mode === "verified-only") {
    return (
      "This agent can only transact through contracts the attestation registry currently lists " +
      "as verified — checked on-chain every time it signs. Verified means the contract's source " +
      "provenance is reproducible, not that it is audited or safe, and it says nothing about who " +
      "receives the payment. If a legitimate resource is blocked, get its contract verified, pay " +
      "it yourself with your passkey, or re-issue this key without the restriction."
    );
  }
  return (
    "Verified-only spending is OFF for this agent: it can transact through unverified contracts, " +
    `within its spending limit. Your reason: "${decision.reason}". You can revoke the key at any time.`
  );
}
