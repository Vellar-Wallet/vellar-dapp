// Mock GET route returning a fixed sample account cleanup plan. No chain or
// DB access.
import http from "node:http";
import { pathToFileURL } from "node:url";

const BLOCKER_TYPES = ["trustline", "offer", "data_entry", "signer", "balance"];

const SAMPLE_BLOCKERS = [
  {
    type: "trustline",
    description: "Trustline to USDC must be removed before the account can be merged.",
  },
  {
    type: "offer",
    description: "One open offer (XLM for EURC) is still on the order book.",
  },
  {
    type: "data_entry",
    description: 'Managed data entry "vellar:device" must be deleted.',
  },
];

// mergeReady is always derived from the blockers list — never stored alongside
// it — so the two can't drift apart.
export function buildPlan(blockers) {
  return {
    accountId: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
    generatedAt: "2026-07-20T09:00:00.000Z",
    blockers,
    mergeReady: blockers.length === 0,
  };
}

export function handleRequest() {
  return { status: 200, body: buildPlan(SAMPLE_BLOCKERS) };
}

export { BLOCKER_TYPES, SAMPLE_BLOCKERS };

// pathToFileURL keeps the entrypoint check correct on Windows and with
// relative argv paths, where a raw `file://` + argv[1] concatenation never
// matches import.meta.url.
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/cleanup-plan") {
      const { status, body } = handleRequest();
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4047;
  server.listen(port, () => {
    console.log(`cleanup-plan mock listening on http://localhost:${port}/cleanup-plan`);
  });
}
