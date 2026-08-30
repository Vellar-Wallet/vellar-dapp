// Mock GET route returning a cursor-paginated list of sample activity log
// entries. No chain or DB access.
import http from "node:http";
import { URL } from "node:url";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;

// 18 hardcoded sample entries, ordered newest-first like a real activity
// feed. Ids are used as opaque cursors -- a real backend would likely use
// a timestamp or a base64-encoded composite key, but a plain id is
// sufficient for a mock and keeps the example easy to read.
const ENTRIES = [
  {
    id: "act_018",
    type: "payment_sent",
    summary: "Sent 25 XLM to GABCD...FGH",
    timestamp: "2026-07-28T09:45:00.000Z",
  },
  {
    id: "act_017",
    type: "policy_updated",
    summary: "Updated spending-limit policy pol_1001",
    timestamp: "2026-07-28T09:30:00.000Z",
  },
  {
    id: "act_016",
    type: "payment_received",
    summary: "Received 100 USDC from GXYZ9...WVU",
    timestamp: "2026-07-28T09:10:00.000Z",
  },
  {
    id: "act_015",
    type: "session_started",
    summary: "New session started from Chrome/macOS",
    timestamp: "2026-07-28T08:55:00.000Z",
  },
  {
    id: "act_014",
    type: "trustline_added",
    summary: "Added trustline for AQUA",
    timestamp: "2026-07-27T22:40:00.000Z",
  },
  {
    id: "act_013",
    type: "payment_sent",
    summary: "Sent 5.5 XLM to GDEF12...MNO",
    timestamp: "2026-07-27T21:15:00.000Z",
  },
  {
    id: "act_012",
    type: "policy_created",
    summary: "Created allowlist policy pol_2002",
    timestamp: "2026-07-27T20:05:00.000Z",
  },
  {
    id: "act_011",
    type: "account_funded",
    summary: "Account funded via testnet friendbot",
    timestamp: "2026-07-27T18:30:00.000Z",
  },
  {
    id: "act_010",
    type: "payment_received",
    summary: "Received 42 XLM from GHIJ34...PQR",
    timestamp: "2026-07-27T16:20:00.000Z",
  },
  {
    id: "act_009",
    type: "session_expired",
    summary: "Session sess_44a1 expired",
    timestamp: "2026-07-27T12:00:00.000Z",
  },
  {
    id: "act_008",
    type: "policy_updated",
    summary: "Paused spending-limit policy pol_1001",
    timestamp: "2026-07-26T23:10:00.000Z",
  },
  {
    id: "act_007",
    type: "payment_sent",
    summary: "Sent 1000 AQUA to GKLM56...STU",
    timestamp: "2026-07-26T19:45:00.000Z",
  },
  {
    id: "act_006",
    type: "trustline_removed",
    summary: "Removed trustline for MOBI",
    timestamp: "2026-07-26T14:05:00.000Z",
  },
  {
    id: "act_005",
    type: "policy_created",
    summary: "Created multi-sig policy pol_3003",
    timestamp: "2026-07-25T22:50:00.000Z",
  },
  {
    id: "act_004",
    type: "payment_received",
    summary: "Received 10 USDT from GNOP78...VWX",
    timestamp: "2026-07-25T15:30:00.000Z",
  },
  {
    id: "act_003",
    type: "session_started",
    summary: "New session started from Firefox/Windows",
    timestamp: "2026-07-24T09:00:00.000Z",
  },
  {
    id: "act_002",
    type: "account_funded",
    summary: "Account funded via testnet friendbot",
    timestamp: "2026-07-23T11:15:00.000Z",
  },
  {
    id: "act_001",
    type: "wallet_created",
    summary: "Wallet created",
    timestamp: "2026-07-23T10:00:00.000Z",
  },
];

function parseLimit(raw) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

/**
 * `cursor` is the id of the last entry the caller has already seen (i.e.
 * "give me entries strictly after this one"), or omitted/empty for the
 * first page. An unrecognized cursor is treated as "start from the
 * beginning" rather than erroring, since a stale cursor from a page that
 * no longer exists shouldn't break the caller's pagination loop.
 */
function findStartIndex(cursor) {
  if (!cursor) return 0;
  const index = ENTRIES.findIndex((entry) => entry.id === cursor);
  return index === -1 ? 0 : index + 1;
}

export function handleRequest({ query = {} } = {}) {
  const limit = parseLimit(query.limit);
  const startIndex = findStartIndex(query.cursor);

  const items = ENTRIES.slice(startIndex, startIndex + limit);
  const nextIndex = startIndex + items.length;
  const nextCursor = nextIndex < ENTRIES.length ? (items[items.length - 1]?.id ?? null) : null;

  return {
    status: 200,
    body: {
      items,
      nextCursor,
    },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/activity-log") {
      const query = Object.fromEntries(url.searchParams);
      const { status, body } = handleRequest({ query });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4059;
  server.listen(port, () => {
    console.log(
      `activity-log-cursor mock listening on http://localhost:${port}/activity-log?cursor=&limit=`,
    );
  });
}
