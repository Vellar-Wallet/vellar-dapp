import { describe, expect, it } from "vitest";
import { createHistoryClient } from "./history";
import { decodePageCursor } from "./history-parse";
import type { HistoryTx } from "./history-types";

// Live-testnet integration coverage for issue #403 (acceptance criterion:
// "History lists both classic and Soroban/SAC transfers, verified against a
// real USDC transfer").
//
// This drives the REAL client against soroban-testnet.stellar.org and
// horizon-testnet.stellar.org, so it is the check that the wire-format
// assumptions behind history-parse.ts still hold. The unit tests pin the
// parsing; this pins the network.
//
// It talks to public endpoints and asserts only invariants that must hold for
// any live chain (every row carries an asset and an explorer-able hash; a
// second page continues rather than repeating) rather than pinning specific
// ledgers, so it does not rot. Skipped automatically without network access.

const RPC_URL = process.env.NEXT_PUBLIC_STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const HORIZON_URL = process.env.NEXT_PUBLIC_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const PASSPHRASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";

/** An account observed receiving a real Circle USDC SAC transfer on testnet. */
const USDC_RECIPIENT = "GDBXA45UBW2O3UH2RJOCOBXRGEMIP5745RQRINZZ2WHKECHHKKUWDOBH";
/** An account observed receiving a real native XLM SAC transfer on testnet. */
const XLM_RECIPIENT = "GB6V3N3NB2WLHWFAL3TBJTZBZR2Q3YHOCSHXZZU6ONYA3CTKKN26APFC";

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Pages back until `match` accepts a row, or the history runs out.
 *
 * A page is a fixed LEDGER WINDOW, not "the account's N most recent
 * transactions" — a window of a couple of minutes of chain is genuinely
 * time-boxed. So a fixture account's USDC (or XLM) transfer may simply not fall
 * inside the first window. That is correct behaviour, not a failure; the test
 * walks the same "Load older" path the dashboard uses.
 */
async function findRow(
  accountId: string,
  match: (row: HistoryTx) => boolean,
  maxPages = 12,
): Promise<{ rows: HistoryTx[]; pages: number }> {
  let cursor: string | undefined;
  const rows: HistoryTx[] = [];
  for (let page = 0; page < maxPages; page++) {
    const result = await client().fetchPage({ accountId, network: "testnet", pageSize: 50, cursor });
    // Newest first, within every page.
    const stamps = result.rows.map((r) => Date.parse(r.timestamp));
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);
    rows.push(...result.rows);
    if (result.rows.some(match)) return { rows, pages: page + 1 };
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return { rows, pages: maxPages };
}


function client() {
  return createHistoryClient({
    rpcUrl: RPC_URL,
    horizonUrl: HORIZON_URL,
    networkPassphrase: PASSPHRASE,
  });
}

async function online(): Promise<boolean> {
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const skip = !(await online());

describe.skipIf(skip)("history client against live testnet", () => {
  it("surfaces a real USDC SAC transfer with its amount and asset", async () => {
    const found = await findRow(
      USDC_RECIPIENT,
      (row) => row.kind === "soroban" && row.asset.code === "USDC",
    );

    const usdcRows = found.rows.filter(
      (row) => row.kind === "soroban" && row.asset.code === "USDC",
    );
    // The acceptance criterion for this issue, checked against a real transfer.
    expect(usdcRows.length).toBeGreaterThan(0);

    // A zero-amount transfer is legitimate chain data (testnet faucets emit
    // them), so the invariant is that the amount is faithfully parsed and at
    // least one of them moved something.
    expect(usdcRows.some((row) => row.amount > 0n)).toBe(true);
    for (const row of usdcRows) {
      expect(row.amount).toBeGreaterThanOrEqual(0n);
      // An amount is never rendered without its asset.
      expect(row.asset.code).toBe("USDC");
      expect(row.asset.contractId).toMatch(/^C/);
      // Every row links to a real explorer entry.
      expect(row.txHash).toMatch(HEX64);
      expect(row.counterparty).not.toBe("");
      expect(Number.isNaN(Date.parse(row.timestamp))).toBe(false);
      expect(["success", "failed"]).toContain(row.status);
    }

    // Newest first — the order the dashboard renders. Asserted per page in
    // findRow, because each page is its own ledger window.
    expect(found.rows.length).toBeGreaterThan(0);
  }, 60_000);

  it("surfaces a real native XLM SAC transfer (the 3-topic/other-contract shape)", async () => {
    const found = await findRow(
      XLM_RECIPIENT,
      (row) => row.kind === "soroban" && row.asset.code === "XLM",
    );

    const xlmRows = found.rows.filter(
      (row) => row.kind === "soroban" && row.asset.code === "XLM",
    );
    expect(
      xlmRows.length,
      `no XLM row in ${found.pages} page(s), ${found.rows.length} rows seen: ${JSON.stringify(
        [...new Set(found.rows.map((r) => r.asset.code))],
      )}`,
    ).toBeGreaterThan(0);
    expect(xlmRows.some((row) => row.amount > 0n)).toBe(true);
    for (const row of xlmRows) {
      expect(row.amount).toBeGreaterThanOrEqual(0n);
      expect(row.txHash).toMatch(HEX64);
      // The native SAC is a different contract from USDC: this is the case
      // that proves rows are not hard-coded to one issuer.
      expect(row.asset.contractId).toBe("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC");
    }
  }, 60_000);

  it("does not raise on a contract address when reading the classic rail", async () => {
    // Horizon answers 400 for a C-address, so the classic rail must be skipped
    // for smart accounts. Unguarded, this made history fail for every wallet.
    const accountId = USDC_RECIPIENT.replace(/^G/, "C");
    await expect(
      client().fetchPage({ accountId, network: "testnet", pageSize: 5 }),
    ).resolves.toBeDefined();
  }, 60_000);

  it("continues to older rows on a second page instead of repeating the first", async () => {
    const first = await client().fetchPage({
      accountId: USDC_RECIPIENT,
      network: "testnet",
      pageSize: 5,
    });
    if (!first.nextCursor) {
      // No older history right now; the invariant is vacuous, not failed.
      return;
    }
    expect(decodePageCursor(first.nextCursor)).toBeDefined();

    const second = await client().fetchPage({
      accountId: USDC_RECIPIENT,
      network: "testnet",
      cursor: first.nextCursor,
      pageSize: 5,
    });
    const firstIds = new Set(first.rows.map((r) => r.id));
    const repeated = second.rows.filter((r) => firstIds.has(r.id));
    // Cursors must advance; re-serving the same page is the L6-class defect.
    expect(repeated.length).toBe(0);
  }, 90_000);
});
