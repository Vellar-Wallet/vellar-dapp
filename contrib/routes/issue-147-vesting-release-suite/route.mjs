// Mock route suite tracking a vesting schedule and reporting the claimable
// amount as a simulated current time advances through several release
// points. In-memory only, no chain, RPC, or database access. State resets
// whenever the process restarts.
import http from "node:http";
import { URL } from "node:url";

// Sample schedule: 10,000 tokens released in four equal tranches at fixed
// dates, with no linear vesting in between (a "cliff series" schedule).
const TOTAL_AMOUNT = 10000;
const RELEASE_POINTS = [
  { date: "2026-01-01T00:00:00.000Z", amount: 2500 },
  { date: "2026-04-01T00:00:00.000Z", amount: 2500 },
  { date: "2026-07-01T00:00:00.000Z", amount: 2500 },
  { date: "2026-10-01T00:00:00.000Z", amount: 2500 },
];

let claimedAmount = 0;

export function resetState() {
  claimedAmount = 0;
}

function isValidDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function parseSimulatedTime(query) {
  const { now } = query;
  if (!now) {
    return { error: { status: 400, body: { error: "missing_now", message: "now query parameter is required" } } };
  }
  const parsed = new Date(now);
  if (!isValidDate(parsed)) {
    return { error: { status: 400, body: { error: "invalid_now", message: "now must be a valid ISO date" } } };
  }
  return { value: parsed };
}

function totalVestedAt(simulatedNow) {
  const nowMs = simulatedNow.getTime();
  return RELEASE_POINTS.filter((point) => new Date(point.date).getTime() <= nowMs).reduce(
    (sum, point) => sum + point.amount,
    0,
  );
}

// GET /vesting/schedule — returns the static release schedule, independent
// of simulated time.
export function schedule() {
  return {
    status: 200,
    body: {
      totalAmount: TOTAL_AMOUNT,
      releases: RELEASE_POINTS.map((point) => ({ date: point.date, amount: point.amount })),
    },
  };
}

// GET /vesting/claimable?now=... — returns the amount vested and claimable
// as of the given simulated time, net of anything already claimed.
export function claimable({ query = {} } = {}) {
  const parsed = parseSimulatedTime(query);
  if (parsed.error) return parsed.error;

  const vested = totalVestedAt(parsed.value);
  const claimableNow = Math.max(0, vested - claimedAmount);

  return {
    status: 200,
    body: {
      now: parsed.value.toISOString(),
      totalAmount: TOTAL_AMOUNT,
      vested,
      claimed: claimedAmount,
      claimable: claimableNow,
    },
  };
}

// POST /vesting/claim — claims whatever is currently claimable as of the
// given simulated time and records it against the running claimed total.
export function claim({ query = {} } = {}) {
  const parsed = parseSimulatedTime(query);
  if (parsed.error) return parsed.error;

  const vested = totalVestedAt(parsed.value);
  const claimableNow = Math.max(0, vested - claimedAmount);
  claimedAmount += claimableNow;

  return {
    status: 200,
    body: {
      now: parsed.value.toISOString(),
      claimedThisRequest: claimableNow,
      totalClaimed: claimedAmount,
    },
  };
}

export function handleRequest({ method = "GET", path = "", query = {} } = {}) {
  if (path === "/vesting/schedule") {
    return method === "GET" ? schedule() : { status: 405, body: { error: "method_not_allowed" } };
  }
  if (path === "/vesting/claimable") {
    return method === "GET"
      ? claimable({ query })
      : { status: 405, body: { error: "method_not_allowed" } };
  }
  if (path === "/vesting/claim") {
    return method === "POST" ? claim({ query }) : { status: 405, body: { error: "method_not_allowed" } };
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
  const port = process.env.PORT || 4147;
  server.listen(port, () => {
    console.log(`vesting-release-suite listening on http://localhost:${port}`);
    console.log(`  GET  /vesting/schedule`);
    console.log(`  GET  /vesting/claimable?now=2026-05-01`);
    console.log(`  POST /vesting/claim?now=2026-05-01`);
  });
}
