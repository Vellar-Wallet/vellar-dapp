import type { PolicyDefinition } from "@vellar/types";

// Local record of policy definitions this browser deployed and attached
// (#570). The chain only stores each policy as a standalone policy signer —
// its definition is not readable from the ledger — so the builder keeps the
// definition alongside the contract id at deploy time. Used to detect scope
// overlap with an already-attached policy before a second deploy. Mirrors the
// agent-keys metadata store (lib/agent-keys.ts): same localStorage pattern,
// same "no authoritative server copy" posture.

export interface PolicyDeploymentRecord {
  contractId: string;
  definition: PolicyDefinition;
  deployedAt: string;
}

const KEY_PREFIX = "vellar.policy-deployments";

function keyFor(accountId: string): string {
  return `${KEY_PREFIX}:${accountId}`;
}

export function listPolicyDeployments(accountId: string): PolicyDeploymentRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(keyFor(accountId));
    const parsed = raw ? (JSON.parse(raw) as PolicyDeploymentRecord[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordPolicyDeployment(
  accountId: string,
  contractId: string,
  definition: PolicyDefinition,
): void {
  if (typeof window === "undefined") return;
  const current = listPolicyDeployments(accountId).filter((r) => r.contractId !== contractId);
  current.push({
    contractId,
    definition,
    deployedAt: new Date().toISOString(),
  });
  window.localStorage.setItem(keyFor(accountId), JSON.stringify(current));
}

/** Deployment records whose contract id is still an attached policy signer. */
export function attachedPolicyDefinitions(
  accountId: string,
  attachedPolicyIds: string[],
): Array<{ label: string; definition: PolicyDefinition }> {
  const live = new Set(attachedPolicyIds);
  return listPolicyDeployments(accountId)
    .filter((r) => live.has(r.contractId))
    .map((r) => ({ label: r.contractId, definition: r.definition }));
}
