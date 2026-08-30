import http from "node:http";

/**
 * Mock GET Route: Multisig Config (Issue #128)
 * Returns a fixed sample multisig threshold and signer set for an account.
 */

const sampleAccounts = {
  GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZLXF3WGC6W263L2B: {
    threshold: 2,
    signers: [
      { key: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZLXF3WGC6W263L2B", type: "ed25519_public_key", weight: 1 },
      { key: "GCEXAMPLE2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", type: "ed25519_public_key", weight: 1 },
      { key: "GCEXAMPLE3BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", type: "ed25519_public_key", weight: 1 },
    ],
  },
  GDIFFERENTACCOUNT4CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC: {
    threshold: 1,
    signers: [
      { key: "GDIFFERENTACCOUNT4CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", type: "ed25519_public_key", weight: 2 },
      { key: "GCEXAMPLE5DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", type: "ed25519_public_key", weight: 1 },
    ],
  },
};

export function getMultisigConfig(account) {
  const config = sampleAccounts[account];
  if (!config) {
    return { status: 404, payload: { error: "account_not_found" } };
  }

  return {
    status: 200,
    payload: { account, threshold: config.threshold, signers: config.signers },
  };
}

export function handleRequest(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed. Use GET." }));
    return;
  }

  const url = new URL(req.url, "http://localhost");
  const account = url.searchParams.get("account");

  if (!account) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "account_required" }));
    return;
  }

  const { status, payload } = getMultisigConfig(account);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

export const sampleAccountIds = Object.keys(sampleAccounts);

const PORT = process.env.PORT || 4128;
if (process.argv[1] && process.argv[1].endsWith("route.mjs")) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/multisig-config")) {
      handleRequest(req, res);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });

  server.listen(PORT, () => {
    console.log(`multisig-config mock listening on http://localhost:${PORT}/multisig-config`);
  });
}
