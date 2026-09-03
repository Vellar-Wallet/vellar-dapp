// Mock route suite estimating a transaction fee from a simulated network
// load level. No chain, RPC, or database access — every value below is
// fixed sample data.
import http from "node:http";
import { URL, pathToFileURL } from "node:url";

// Stroops charged per operation when the network is idle. Mirrors the
// Stellar base fee so the numbers look familiar, but it is sample data.
const BASE_FEE_PER_OPERATION = 100;

// Multiplier applied to the base fee for each supported load level.
const LOAD_MULTIPLIERS = {
  low: 1,
  medium: 4,
  high: 12,
};

const LOAD_LEVELS = Object.keys(LOAD_MULTIPLIERS);

// Fixed sample series of recent load observations, oldest first.
const LOAD_HISTORY = [
  { observedAt: "2026-07-27T18:00:00.000Z", load: "low" },
  { observedAt: "2026-07-27T19:00:00.000Z", load: "low" },
  { observedAt: "2026-07-27T20:00:00.000Z", load: "medium" },
  { observedAt: "2026-07-27T21:00:00.000Z", load: "high" },
  { observedAt: "2026-07-27T22:00:00.000Z", load: "high" },
  { observedAt: "2026-07-27T23:00:00.000Z", load: "medium" },
];

function parseOperations(raw) {
  if (raw === undefined || raw === "") return 1;
  // Reject anything that is not a plain positive integer, including
  // values like "2.5" or "3abc" that Number() would otherwise coerce.
  if (!/^\d+$/.test(String(raw))) return null;
  const operations = Number(raw);
  return operations >= 1 && operations <= 100 ? operations : null;
}

export function estimate({ query = {} } = {}) {
  const load = query.load;
  if (!LOAD_LEVELS.includes(load)) {
    return {
      status: 400,
      body: {
        error: "invalid_load",
        message: `load must be one of: ${LOAD_LEVELS.join(", ")}`,
      },
    };
  }

  const operations = parseOperations(query.operations);
  if (operations === null) {
    return {
      status: 400,
      body: {
        error: "invalid_operations",
        message: "operations must be an integer between 1 and 100",
      },
    };
  }

  const multiplier = LOAD_MULTIPLIERS[load];
  return {
    status: 200,
    body: {
      load,
      operations,
      multiplier,
      baseFeePerOperation: BASE_FEE_PER_OPERATION,
      feePerOperation: BASE_FEE_PER_OPERATION * multiplier,
      estimatedFee: BASE_FEE_PER_OPERATION * multiplier * operations,
      unit: "stroops",
    },
  };
}

export function loadHistory() {
  return {
    status: 200,
    body: {
      samples: LOAD_HISTORY.map((sample) => ({ ...sample })),
      count: LOAD_HISTORY.length,
      latest: LOAD_HISTORY[LOAD_HISTORY.length - 1].load,
    },
  };
}

export function handleRequest({ method = "GET", path = "", query = {} } = {}) {
  if (method !== "GET") {
    return { status: 405, body: { error: "method_not_allowed" } };
  }
  if (path === "/fee-load/estimate") return estimate({ query });
  if (path === "/fee-load/load-history") return loadHistory();
  return { status: 404, body: { error: "not_found" } };
}

// pathToFileURL keeps this check correct on Windows paths; argv[1] is
// undefined when the module is imported rather than executed.
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
const isMain = entry !== null && import.meta.url === entry;
if (isMain) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const { status, body } = handleRequest({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
    });
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const port = process.env.PORT || 4117;
  server.listen(port, () => {
    console.log(`fee-load suite listening on http://localhost:${port}`);
    console.log(`  GET /fee-load/estimate?load=low|medium|high&operations=1`);
    console.log(`  GET /fee-load/load-history`);
  });
}
