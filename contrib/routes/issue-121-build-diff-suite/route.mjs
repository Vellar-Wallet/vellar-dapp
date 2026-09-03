// Mock route suite comparing two sample contract build results and
// reporting which fields differ. No chain, RPC, or database access —
// every build record below is fixed sample data.
import http from "node:http";
import { URL, pathToFileURL } from "node:url";

// Fields compared by the compare endpoint, in report order.
const COMPARED_FIELDS = ["wasmHash", "size", "compiler", "optimized"];

// Sample build records for the same contract. Builds 1 and 3 are byte
// identical reproductions of each other; the others diverge.
const BUILDS = [
  {
    id: "build_001",
    contract: "vellar_verified_registry",
    builtAt: "2026-07-26T09:15:00.000Z",
    wasmHash: "9f2c41ab7d0e5c68b3aa10f4e7c9d2b581a6f3049ce7bb2d4a1f8036c5e9d7a2",
    size: 41728,
    compiler: "soroban-cli 21.5.0",
    optimized: true,
  },
  {
    id: "build_002",
    contract: "vellar_verified_registry",
    builtAt: "2026-07-26T14:02:00.000Z",
    wasmHash: "3d81ff05a6c94e27b1d0e5a83f6c721940bb5e3c8d2a7f61049ce3b8a5d20f74",
    size: 43904,
    compiler: "soroban-cli 21.5.0",
    optimized: false,
  },
  {
    id: "build_003",
    contract: "vellar_verified_registry",
    builtAt: "2026-07-27T08:41:00.000Z",
    wasmHash: "9f2c41ab7d0e5c68b3aa10f4e7c9d2b581a6f3049ce7bb2d4a1f8036c5e9d7a2",
    size: 41728,
    compiler: "soroban-cli 21.5.0",
    optimized: true,
  },
  {
    id: "build_004",
    contract: "vellar_verified_registry",
    builtAt: "2026-07-27T16:20:00.000Z",
    wasmHash: "c07a5e9182b4d36f0ae7c1b58d29f43607e5a2c9418bd63f0a7e259c4d18b3f6",
    size: 41728,
    compiler: "soroban-cli 22.0.1",
    optimized: true,
  },
];

function findBuild(id) {
  return BUILDS.find((build) => build.id === id);
}

export function builds() {
  return {
    status: 200,
    body: {
      builds: BUILDS.map((build) => ({ ...build })),
      count: BUILDS.length,
      comparedFields: [...COMPARED_FIELDS],
    },
  };
}

export function compare({ query = {} } = {}) {
  const { a, b } = query;
  if (!a || !b) {
    return {
      status: 400,
      body: {
        error: "missing_build_id",
        message: "both a and b build ids are required",
      },
    };
  }

  const left = findBuild(a);
  const right = findBuild(b);
  const unknown = [
    ...(left ? [] : [a]),
    ...(right ? [] : [b]),
  ];
  if (unknown.length > 0) {
    return {
      status: 404,
      body: {
        error: "build_not_found",
        message: `unknown build id(s): ${unknown.join(", ")}`,
      },
    };
  }

  const differences = COMPARED_FIELDS.filter(
    (field) => left[field] !== right[field],
  ).map((field) => ({ field, a: left[field], b: right[field] }));

  return {
    status: 200,
    body: {
      a: left.id,
      b: right.id,
      contract: left.contract,
      identical: differences.length === 0,
      differingFields: differences.map((difference) => difference.field),
      differences,
    },
  };
}

export function handleRequest({ method = "GET", path = "", query = {} } = {}) {
  if (method !== "GET") {
    return { status: 405, body: { error: "method_not_allowed" } };
  }
  if (path === "/build-diff/builds") return builds();
  if (path === "/build-diff/compare") return compare({ query });
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
  const port = process.env.PORT || 4121;
  server.listen(port, () => {
    console.log(`build-diff suite listening on http://localhost:${port}`);
    console.log(`  GET /build-diff/builds`);
    console.log(`  GET /build-diff/compare?a=build_001&b=build_002`);
  });
}
