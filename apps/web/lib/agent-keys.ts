import type { WalletSigner } from "passkey-kit";

export type AgentKeyStatus = "active" | "expired" | "revoked";

export interface AgentKeyRecord {
  publicKey: string;
  label: string;
  status: AgentKeyStatus;
  storage: WalletSigner["storage"];
  expiration?: number;
  boundContracts: string[];
  policyContractIds: string[];
}

export interface AgentKeyIndexer {
  getSigners(wallet: string): Promise<WalletSigner[]>;
}

export interface AgentKeyKit {
  getSigner(key: unknown): Promise<unknown | null>;
  remove(key: unknown): Promise<unknown>;
  sign(tx: unknown): Promise<unknown>;
}

export interface AgentKeyBackend {
  submitTransaction(req: { signedXdr: string; network: string }): Promise<{ hash: string }>;
}

export interface AgentKeyDeps {
  indexer: AgentKeyIndexer;
  kit: AgentKeyKit;
  backend: AgentKeyBackend;
  network: string;
  SignerKey: {
    Ed25519(publicKey: string): unknown;
    Policy(contractId: string): unknown;
  };
  now?: () => number;
}

function shortKey(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

function policyIds(signer: WalletSigner): string[] {
  const ids = new Set<string>();
  for (const required of signer.limits?.values() ?? []) {
    for (const key of required ?? []) {
      if (key.key === "Policy") ids.add(key.value);
    }
  }
  return [...ids];
}

function toXdr(signed: unknown, fallback: unknown): string {
  const value = signed ?? fallback;
  return typeof value === "string" ? value : (value as { toXDR(): string }).toXDR();
}

/**
 * Enumerate Ed25519 agent keys from the chain index, then confirm every row
 * against the wallet contract. The indexer is discovery only: getSigner is the
 * authority for whether a key is still live, so a revoke from another device
 * is reflected here even while the indexer catches up.
 */
export async function listAgentKeys(deps: AgentKeyDeps, wallet: string): Promise<AgentKeyRecord[]> {
  const now = deps.now?.() ?? Date.now();
  const rows = (await deps.indexer.getSigners(wallet)).filter(
    (row) => row.key.key === "Ed25519",
  );

  return Promise.all(
    rows.map(async (row) => {
      const live = await deps.kit.getSigner(deps.SignerKey.Ed25519(row.key.value));
      const expired = row.expiration !== undefined && row.expiration * 1000 <= now;
      return {
        publicKey: row.key.value,
        label: `Agent key ${shortKey(row.key.value)}`,
        status: live === null || row.status === "removed" || row.status === "evicted"
          ? "revoked"
          : expired || row.status === "expired"
            ? "expired"
            : "active",
        storage: row.storage,
        ...(row.expiration !== undefined ? { expiration: row.expiration } : {}),
        boundContracts: [...(row.limits?.keys() ?? [])],
        policyContractIds: policyIds(row),
      } satisfies AgentKeyRecord;
    }),
  );
}

export interface RevokeAgentKeyResult {
  alreadyRevoked: boolean;
  hashes: string[];
}

/**
 * Remote kill switch. Detach required policies first, then remove the Ed25519
 * key. Once a required policy is absent the in-flight agent authorization can
 * no longer verify; removing the key then makes the revocation explicit. Every
 * write is signed by the connected admin passkey.
 */
export async function revokeAgentKey(
  deps: AgentKeyDeps,
  publicKey: string,
  policyContractIds: string[],
): Promise<RevokeAgentKeyResult> {
  const agentKey = deps.SignerKey.Ed25519(publicKey);
  if ((await deps.kit.getSigner(agentKey)) === null) {
    return { alreadyRevoked: true, hashes: [] };
  }

  const hashes: string[] = [];
  for (const policyId of [...new Set(policyContractIds)]) {
    const policyKey = deps.SignerKey.Policy(policyId);
    if ((await deps.kit.getSigner(policyKey)) === null) continue;
    const tx = await deps.kit.remove(policyKey);
    const signed = await deps.kit.sign(tx);
    const submitted = await deps.backend.submitTransaction({
      signedXdr: toXdr(signed, tx),
      network: deps.network,
    });
    hashes.push(submitted.hash);
  }

  // Re-check after policy detach: another device may have revoked the key.
  if ((await deps.kit.getSigner(agentKey)) !== null) {
    const tx = await deps.kit.remove(agentKey);
    const signed = await deps.kit.sign(tx);
    const submitted = await deps.backend.submitTransaction({
      signedXdr: toXdr(signed, tx),
      network: deps.network,
    });
    hashes.push(submitted.hash);
  }

  return { alreadyRevoked: false, hashes };
}
