// Mock GET route returning a fixed sample token vesting schedule for an
// account. No chain, RPC, or database access — the schedule is a static
// in-memory sample, so the handler is pure.
import http from "node:http";
import { pathToFileURL } from "node:url";

export const VESTING_SCHEDULE = {
  account: "GABC123SAMPLEACCOUNT",
  asset: "VELLAR",
  releases: [
    { date: "2026-01-15T00:00:00.000Z", amount: "1000.0000000" },
    { date: "2026-04-15T00:00:00.000Z", amount: "1500.0000000" },
    { date: "2026-07-15T00:00:00.000Z", amount: "2000.0000000" },
    { date: "2026-10-15T00:00:00.000Z", amount: "2500.0000000" },
  ],
};

export function handleRequest({ method = "GET", path = "" } = {}) {
  if (path !== "/vesting-schedule") {
    return { status: 404, body: { error: "not_found" } };
  }
  if (method !== "GET") {
    return { status: 405, body: { error: "method_not_allowed" } };
  }
  return { status: 200, body: VESTING_SCHEDULE };
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
const isMain = entry !== null && import.meta.url === entry;
if (isMain) {
  const server = http.createServer((req, res) => {
    const result = handleRequest({ method: req.method, path: req.url });
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  const port = process.env.PORT || 4129;
  server.listen(port, () => {
    console.log(`vesting-schedule mock listening on http://localhost:${port}/vesting-schedule`);
  });
}
