// Mock route module returning exchange rate history bucketed by hour or
// day, from a fixed sample of rate points. No chain or DB access.
import http from "node:http";
import { URL } from "node:url";

// 30 hourly sample points (XLM/USD), spanning just over a day.
const RATE_POINTS = [
  { timestamp: "2026-07-27T00:00:00.000Z", rate: 0.118 },
  { timestamp: "2026-07-27T01:00:00.000Z", rate: 0.119 },
  { timestamp: "2026-07-27T02:00:00.000Z", rate: 0.117 },
  { timestamp: "2026-07-27T03:00:00.000Z", rate: 0.12 },
  { timestamp: "2026-07-27T04:00:00.000Z", rate: 0.121 },
  { timestamp: "2026-07-27T05:00:00.000Z", rate: 0.122 },
  { timestamp: "2026-07-27T06:00:00.000Z", rate: 0.12 },
  { timestamp: "2026-07-27T07:00:00.000Z", rate: 0.119 },
  { timestamp: "2026-07-27T08:00:00.000Z", rate: 0.118 },
  { timestamp: "2026-07-27T09:00:00.000Z", rate: 0.117 },
  { timestamp: "2026-07-27T10:00:00.000Z", rate: 0.116 },
  { timestamp: "2026-07-27T11:00:00.000Z", rate: 0.115 },
  { timestamp: "2026-07-27T12:00:00.000Z", rate: 0.117 },
  { timestamp: "2026-07-27T13:00:00.000Z", rate: 0.118 },
  { timestamp: "2026-07-27T14:00:00.000Z", rate: 0.12 },
  { timestamp: "2026-07-27T15:00:00.000Z", rate: 0.121 },
  { timestamp: "2026-07-27T16:00:00.000Z", rate: 0.123 },
  { timestamp: "2026-07-27T17:00:00.000Z", rate: 0.124 },
  { timestamp: "2026-07-27T18:00:00.000Z", rate: 0.122 },
  { timestamp: "2026-07-27T19:00:00.000Z", rate: 0.121 },
  { timestamp: "2026-07-27T20:00:00.000Z", rate: 0.12 },
  { timestamp: "2026-07-27T21:00:00.000Z", rate: 0.119 },
  { timestamp: "2026-07-27T22:00:00.000Z", rate: 0.118 },
  { timestamp: "2026-07-27T23:00:00.000Z", rate: 0.117 },
  { timestamp: "2026-07-28T00:00:00.000Z", rate: 0.116 },
  { timestamp: "2026-07-28T01:00:00.000Z", rate: 0.115 },
  { timestamp: "2026-07-28T02:00:00.000Z", rate: 0.114 },
  { timestamp: "2026-07-28T03:00:00.000Z", rate: 0.116 },
  { timestamp: "2026-07-28T04:00:00.000Z", rate: 0.117 },
  { timestamp: "2026-07-28T05:00:00.000Z", rate: 0.118 },
];

function bucketKey(timestamp, bucket) {
  // Hourly bucket: truncate to the hour. Daily bucket: truncate to the day.
  return bucket === "daily" ? timestamp.slice(0, 10) : timestamp.slice(0, 13);
}

function average(values) {
  const sum = values.reduce((acc, v) => acc + v, 0);
  return Math.round((sum / values.length) * 100000) / 100000;
}

export function handleRequest(query = {}) {
  const bucket = query.bucket === "daily" ? "daily" : "hourly";

  const grouped = new Map();
  for (const point of RATE_POINTS) {
    const key = bucketKey(point.timestamp, bucket);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(point.rate);
  }

  const buckets = Array.from(grouped.entries()).map(([key, rates]) => ({
    bucket: key,
    rate: average(rates),
    samples: rates.length,
  }));

  return { status: 200, body: { bucket, buckets } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/rate-history") {
      const query = Object.fromEntries(url.searchParams);
      const { status, body } = handleRequest(query);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4073;
  server.listen(port, () => {
    console.log(
      `rate-history mock listening on http://localhost:${port}/rate-history?bucket=hourly|daily`,
    );
  });
}
