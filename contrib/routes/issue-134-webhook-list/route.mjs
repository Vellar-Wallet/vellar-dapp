// Mock GET route returning a fixed array of sample webhook subscription
// records. No chain, RPC, or database access — the list is a static
// in-memory sample, so the handler is pure.
import http from "node:http";
import { pathToFileURL } from "node:url";

export const SAMPLE_SUBSCRIPTIONS = [
  {
    url: "https://example.com/hooks/payments",
    events: ["payment.settled", "payment.failed"],
  },
  {
    url: "https://example.com/hooks/accounts",
    events: ["account.created", "account.closed"],
  },
  {
    url: "https://example.com/hooks/policies",
    events: ["policy.updated"],
  },
];

export function handleRequest({ method = "GET", path = "" } = {}) {
  if (path !== "/webhook-subscriptions") {
    return { status: 404, body: { error: "not_found" } };
  }
  if (method !== "GET") {
    return { status: 405, body: { error: "method_not_allowed" } };
  }
  return { status: 200, body: { subscriptions: SAMPLE_SUBSCRIPTIONS } };
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
const isMain = entry !== null && import.meta.url === entry;
if (isMain) {
  const server = http.createServer((req, res) => {
    const result = handleRequest({ method: req.method, path: req.url });
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  const port = process.env.PORT || 4134;
  server.listen(port, () => {
    console.log(`webhook-list mock listening on http://localhost:${port}/webhook-subscriptions`);
  });
}
