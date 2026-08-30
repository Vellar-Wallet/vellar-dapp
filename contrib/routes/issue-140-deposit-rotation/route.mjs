// Mock route module simulating a deposit address rotation flow. Get the
// current deposit address for an account, and rotate it to a newly
// generated one. In-memory only, no chain or DB access. State resets
// whenever the process restarts.
import http from "node:http";
import { URL } from "node:url";
import crypto from "node:crypto";

// Seeded so a freshly-started server always has a current address for
// this sample account, mirroring the other mocks' seeded defaults.
const addresses = new Map([["acct_demo", "GA000INITIALXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"]]);

function makeAddress() {
  return `GD${crypto.randomBytes(28).toString("hex").toUpperCase()}`.slice(0, 56);
}

export function handleGet(accountId) {
  if (!accountId) {
    return { status: 400, body: { error: "account_id_required" } };
  }
  if (!addresses.has(accountId)) {
    // First-time lookup for a never-seen account: mint one lazily so
    // every account has a deposit address, matching real deposit-address
    // provisioning behavior.
    addresses.set(accountId, makeAddress());
  }
  return { status: 200, body: { accountId, address: addresses.get(accountId) } };
}

export function handleRotate(accountId) {
  if (!accountId) {
    return { status: 400, body: { error: "account_id_required" } };
  }
  const previousAddress = addresses.get(accountId) ?? null;

  let nextAddress = makeAddress();
  // Guard against the astronomically unlikely case of generating the same
  // address twice in a row, so "distinct from the previous one" always holds.
  while (nextAddress === previousAddress) {
    nextAddress = makeAddress();
  }

  addresses.set(accountId, nextAddress);
  return {
    status: 200,
    body: { accountId, address: nextAddress, previousAddress },
  };
}

/** Test-only helper to reset in-memory state between test files/runs. */
export function _resetAddresses() {
  addresses.clear();
  addresses.set("acct_demo", "GA000INITIALXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const getMatch = url.pathname.match(/^\/deposit-address\/([^/]+)$/);
    const rotateMatch = url.pathname.match(/^\/deposit-address\/([^/]+)\/rotate$/);

    if (req.method === "POST" && rotateMatch) {
      const { status, body } = handleRotate(decodeURIComponent(rotateMatch[1]));
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    if (req.method === "GET" && getMatch) {
      const { status, body } = handleGet(decodeURIComponent(getMatch[1]));
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4140;
  server.listen(port, () => {
    console.log(
      `deposit-rotation mock listening on http://localhost:${port}/deposit-address/:accountId{,/rotate}`,
    );
  });
}
