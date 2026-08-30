// Mock routes simulating contract upgrade compatibility checks. Given a
// contract's currently deployed wasm hash and a proposed new hash, this
// compares their (sample) metadata and reports whether the upgrade is
// compatible, and if not, why.
import http from "node:http";
import { pathToFileURL } from "node:url";

// Sample "wasm catalog": metadata for each known wasm hash. A real service
// would derive this from the actual contract binary (storage schema version,
// exported function signatures); here it is a fixed sample dataset.
export const WASM_CATALOG = {
  wasm_escrow_v1: {
    storageVersion: 2,
    functions: [
      { name: "deposit", params: ["from", "amount"] },
      { name: "release", params: ["to"] },
      { name: "refund", params: ["to"] },
    ],
  },
  // Compatible upgrade: keeps every existing function with the same
  // signature and the same storage version, and only adds a new function.
  wasm_escrow_v2_compatible: {
    storageVersion: 2,
    functions: [
      { name: "deposit", params: ["from", "amount"] },
      { name: "release", params: ["to"] },
      { name: "refund", params: ["to"] },
      { name: "extend", params: ["seconds"] },
    ],
  },
  // Incompatible upgrade: downgrades the storage schema version and drops
  // the "release" function entirely.
  wasm_escrow_v2_broken: {
    storageVersion: 1,
    functions: [
      { name: "deposit", params: ["from", "amount"] },
      { name: "refund", params: ["to"] },
    ],
  },
  wasm_vault_v1: {
    storageVersion: 1,
    functions: [
      { name: "lock", params: ["amount"] },
      { name: "unlock", params: ["signature"] },
    ],
  },
};

// Sample "registry": which wasm hash each contract currently has deployed.
export const DEPLOYED_CONTRACTS = {
  "escrow-main": { hash: "wasm_escrow_v1" },
  "vault-main": { hash: "wasm_vault_v1" },
};

function getMetadata(hash) {
  return WASM_CATALOG[hash];
}

export function handleCurrentVersion({ body = {} } = {}) {
  const { contractId } = body;
  if (typeof contractId !== "string" || contractId.trim() === "") {
    return {
      status: 400,
      body: { error: "invalid_request", message: "contractId must be a non-empty string" },
    };
  }

  const deployed = DEPLOYED_CONTRACTS[contractId];
  if (!deployed) {
    return {
      status: 404,
      body: { error: "not_found", message: `No contract registered as '${contractId}'` },
    };
  }

  const metadata = getMetadata(deployed.hash);
  return {
    status: 200,
    body: { contractId, hash: deployed.hash, ...metadata },
  };
}

// Compares a proposed wasm's metadata against the currently deployed one and
// lists every concern found, rather than stopping at the first.
function compare(current, proposed) {
  const concerns = [];

  if (proposed.storageVersion < current.storageVersion) {
    concerns.push(
      `storage schema version would downgrade from ${current.storageVersion} to ${proposed.storageVersion}`,
    );
  }

  const proposedByName = new Map(proposed.functions.map((fn) => [fn.name, fn]));
  for (const currentFn of current.functions) {
    const proposedFn = proposedByName.get(currentFn.name);
    if (!proposedFn) {
      concerns.push(`function '${currentFn.name}' would be removed`);
      continue;
    }
    if (proposedFn.params.length !== currentFn.params.length) {
      concerns.push(
        `function '${currentFn.name}' signature would change from (${currentFn.params.join(", ")}) ` +
          `to (${proposedFn.params.join(", ")})`,
      );
    }
  }

  return concerns;
}

export function handleCheckUpgrade({ body = {} } = {}) {
  const { contractId, proposedHash } = body;
  if (typeof contractId !== "string" || contractId.trim() === "") {
    return {
      status: 400,
      body: { error: "invalid_request", message: "contractId must be a non-empty string" },
    };
  }
  if (typeof proposedHash !== "string" || proposedHash.trim() === "") {
    return {
      status: 400,
      body: { error: "invalid_request", message: "proposedHash must be a non-empty string" },
    };
  }

  const deployed = DEPLOYED_CONTRACTS[contractId];
  if (!deployed) {
    return {
      status: 404,
      body: { error: "not_found", message: `No contract registered as '${contractId}'` },
    };
  }

  const currentMetadata = getMetadata(deployed.hash);
  const proposedMetadata = getMetadata(proposedHash);
  if (!proposedMetadata) {
    return {
      status: 404,
      body: { error: "not_found", message: `No wasm registered with hash '${proposedHash}'` },
    };
  }

  const concerns = compare(currentMetadata, proposedMetadata);

  return {
    status: 200,
    body: {
      contractId,
      currentHash: deployed.hash,
      proposedHash,
      compatible: concerns.length === 0,
      concerns,
    },
  };
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url.startsWith("/upgrade/current-version")) {
      const contractId = new URL(req.url, "http://localhost").searchParams.get("contractId");
      const { status, body } = handleCurrentVersion({ body: { contractId } });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    if (req.method === "POST" && req.url === "/upgrade/check-upgrade") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: "invalid_json", message: "Request body must be valid JSON" }),
          );
          return;
        }
        const { status, body: responseBody } = handleCheckUpgrade({ body });
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseBody));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4107;
  server.listen(port, () => {
    console.log(`upgrade-compatibility mock listening on http://localhost:${port}`);
    console.log(`  GET  /upgrade/current-version?contractId=escrow-main`);
    console.log(`  POST /upgrade/check-upgrade`);
  });
}
