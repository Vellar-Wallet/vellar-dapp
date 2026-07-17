import type { Network } from "@vela/types";

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
}

export interface SessionRecord {
  id: string;
  contractId: string;
  network: Network;
  createdAt: string;
  lastActiveAt: string;
}

export interface SessionRepository {
  insert(record: SessionRecord): Promise<void>;
  find(id: string): Promise<SessionRecord | undefined>;
  /** Active sessions for an account, most recently active first (§5.1 device management). */
  listByContract(contractId: string, network: Network): Promise<SessionRecord[]>;
  /** Revokes a session; false when it didn't exist. */
  delete(id: string): Promise<boolean>;
}

export interface AuditEvent {
  type: string;
  at: string;
  data: Record<string, unknown>;
}

export interface AuditLog {
  record(type: string, data: Record<string, unknown>): Promise<void>;
  list(): Promise<AuditEvent[]>;
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
  };
}

export function createMemorySessionRepository(): SessionRepository {
  const sessions = new Map<string, SessionRecord>();
  return {
    async insert(record) {
      sessions.set(record.id, record);
    },
    async find(id) {
      return sessions.get(id);
    },
    async listByContract(contractId, network) {
      return [...sessions.values()]
        .filter((s) => s.contractId === contractId && s.network === network)
        .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
    },
    async delete(id) {
      return sessions.delete(id);
    },
  };
}

export function createMemoryAuditLog(): AuditLog {
  const events: AuditEvent[] = [];
  return {
    async record(type, data) {
      events.push({ type, at: new Date().toISOString(), data });
    },
    async list() {
      return [...events];
    },
  };
}
