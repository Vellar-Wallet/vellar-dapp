// Mock route computing how much of a sample vesting schedule has released
// as of a provided reference date. In-memory only, no chain, RPC, or
// database access.
import http from "node:http";
import { URL } from "node:url";

// Sample schedule: a 12-month cliff-free linear vest of 12,000 tokens,
// starting 2026-01-01 and fully vested by 2027-01-01.
const SCHEDULE = {
  totalAmount: 12000,
  startDate: "2026-01-01T00:00:00.000Z",
  endDate: "2027-01-01T00:00:00.000Z",
};

function isValidDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function computeReleased(referenceDate) {
  const start = new Date(SCHEDULE.startDate).getTime();
  const end = new Date(SCHEDULE.endDate).getTime();
  const ref = referenceDate.getTime();

  if (ref <= start) return 0;
  if (ref >= end) return SCHEDULE.totalAmount;

  const elapsedFraction = (ref - start) / (end - start);
  return Math.round(SCHEDULE.totalAmount * elapsedFraction * 100) / 100;
}

// GET /vesting/calculation?referenceDate=... — returns released and
// remaining locked amounts as of the given reference date.
export function calculate({ query = {} } = {}) {
  const { referenceDate } = query;

  if (!referenceDate) {
    return {
      status: 400,
      body: { error: "missing_reference_date", message: "referenceDate query parameter is required" },
    };
  }

  const parsed = new Date(referenceDate);
  if (!isValidDate(parsed)) {
    return {
      status: 400,
      body: { error: "invalid_reference_date", message: "referenceDate must be a valid ISO date" },
    };
  }

  const released = computeReleased(parsed);
  const remaining = Math.round((SCHEDULE.totalAmount - released) * 100) / 100;

  return {
    status: 200,
    body: {
      referenceDate: parsed.toISOString(),
      totalAmount: SCHEDULE.totalAmount,
      released,
      remaining,
    },
  };
}

export function handleRequest({ method = "GET", path = "", query = {} } = {}) {
  if (path === "/vesting/calculation") {
    return method === "GET"
      ? calculate({ query })
      : { status: 405, body: { error: "method_not_allowed" } };
  }
  return { status: 404, body: { error: "not_found" } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const query = Object.fromEntries(url.searchParams.entries());
    const result = handleRequest({ method: req.method, path: url.pathname, query });
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  const port = process.env.PORT || 4142;
  server.listen(port, () => {
    console.log(`vesting-calculation listening on http://localhost:${port}`);
    console.log(`  GET /vesting/calculation?referenceDate=2026-06-01`);
  });
}
