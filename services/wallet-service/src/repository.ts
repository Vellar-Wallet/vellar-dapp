import type { Network } from "@vellar/types";

// Persistence seams for wallet metadata, session records, and audit logs
// (technical-doc.md §6.3 Wallet Service; idea.md §9 wallets/wallet_sessions/
// activity_logs tables). In-memory implementations back MVP development;
// Postgres implementations replace them behind the same interfaces.

export interface WalletRecord {
  keyId: string; // base64 WebAuthn credential id
  contractId: string; // smart account contract address
  network: Network;
  createdAt: string;
}

export class DuplicateWalletError extends Error {
  constructor(keyId: string, network: Network) {
    super(`Wallet already exists for this passkey on ${network} (keyId ${keyId})`);
    this.name = "DuplicateWalletError";
  }
}

export interface WalletRepository {
  /** Rejects with DuplicateWalletError when the keyId is already mapped on that network. */
  insert(record: WalletRecord): Promise<void>;
  findByKeyId(keyId: string, network: Network): Promise<WalletRecord | undefined>;
  /** True when the server has a wallet record for this contract on this network.
   * Used to scope funding-path submissions to wallets the product created
   * (security-audit.md C1/H1/V2).
   *
   * NOT AUTHENTICATION: a "recognized wallet" only means contractId ==
   * derive(keyId) held at creation (FIX 2). A scripted P-256 keypair yields a
   * valid self-authored deploy, so this is a metering/scoping primitive only —
   * never an identity, trust, or ownership signal. On-chain __check_auth is the
   * only real authority. (See the derivation-gate limitation note in
   * docs/security-audit.md.) */
  existsByContractId(contractId: string, network: Network): Promise<boolean>;
}

export interface SessionRecord {
  id: string;
  contractId: string;
  network: Network;
  createdAt: string;
  lastActiveAt: string;
  /** When this session capability expires (ISO). A session id is a bearer
   * capability for the session routes (security-audit.md RA-3/M1), so it MUST
   * die: 7-day sliding window, matching the device signer's 7-day expiry — if
   * one lifetime changes, change both. `find`/`listByContract` treat an expired
   * row as ABSENT so an expired id never authorizes anything (and never gets a
   * response distinguishing "expired" from "never existed"). */
  expiresAt: string;
}

export interface SessionRepository {
  insert(record: SessionRecord): Promise<void>;
  /** Returns the session ONLY if it exists and is not expired (as of `asOf`,
   * default now) — an expired session is indistinguishable from a missing one. */
  find(id: string, asOf?: Date): Promise<SessionRecord | undefined>;
  /** Non-expired sessions for an account, most recently active first (§5.1). */
  listByContract(contractId: string, network: Network, asOf?: Date): Promise<SessionRecord[]>;
  /** Slides a session forward on AUTHORIZED use: sets lastActiveAt=`at` and
   * expiresAt=`at`+window. No-op (returns false) if the id is absent/expired, so
   * a rejected id can never extend its own life. */
  touch(id: string, at: Date, newExpiresAt: Date): Promise<boolean>;
  /** Revokes a session; false when it didn't exist. */
  delete(id: string): Promise<boolean>;
}

export const SENSITIVE_WALLET_ACTIONS = [
  "wallet.created",
  "wallet.connected",
  "session.revoked",
  "tx.submitted",
  "policy.updated",
  "account.merged",
  "key.rotated",
  "threshold.updated",
  "signer.added",
  "signer.removed",
] as const;

export type SensitiveWalletAction = (typeof SENSITIVE_WALLET_ACTIONS)[number];

export interface AuditEvent {
  type: string;
  at: string;
  data: Record<string, unknown>;
  actor?: string;
}

export interface AuditLog {
  record(type: string, data: Record<string, unknown>, actor?: string): Promise<void>;
  list(filter?: { type?: string; actor?: string }): Promise<AuditEvent[]>;
}

export function createMemoryWalletRepository(): WalletRepository {
  const byKey = new Map<string, WalletRecord>();
  const key = (keyId: string, network: Network) => `${network}:${keyId}`;
  return {
    async insert(record) {
      const k = key(record.keyId, record.network);
      if (byKey.has(k)) throw new DuplicateWalletError(record.keyId, record.network);
      byKey.set(k, record);
    },
    async findByKeyId(keyId, network) {
      return byKey.get(key(keyId, network));
    },
    async existsByContractId(contractId, network) {
      for (const record of byKey.values()) {
        if (record.contractId === contractId && record.network === network) return true;
      }
      return false;
    },
  };
}

export function createMemorySessionRepository(): SessionRepository {
  const sessions = new Map<string, SessionRecord>();
  const isLive = (s: SessionRecord, asOf: Date) => new Date(s.expiresAt).getTime() > asOf.getTime();
  return {
    async insert(record) {
      sessions.set(record.id, record);
    },
    async find(id, asOf = new Date()) {
      const s = sessions.get(id);
      return s && isLive(s, asOf) ? s : undefined;
    },
    async listByContract(contractId, network, asOf = new Date()) {
      return [...sessions.values()]
        .filter((s) => s.contractId === contractId && s.network === network && isLive(s, asOf))
        .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
    },
    async touch(id, at, newExpiresAt) {
      const s = sessions.get(id);
      if (!s || !isLive(s, at)) return false;
      s.lastActiveAt = at.toISOString();
      s.expiresAt = newExpiresAt.toISOString();
      return true;
    },
    async delete(id) {
      return sessions.delete(id);
    },
  };
}

export function createMemoryAuditLog(): AuditLog {
  const events: AuditEvent[] = [];
  return {
    async record(type, data, actor) {
      events.push({ type, at: new Date().toISOString(), data, actor });
    },
    async list(filter) {
      let filtered = [...events];
      if (filter?.type) {
        filtered = filtered.filter((e) => e.type === filter.type);
      }
      if (filter?.actor) {
        filtered = filtered.filter((e) => e.actor === filter.actor);
      }
      return filtered;
    },
  };
}
