import http from "node:http";

/**
 * Mock POST Route: Recipient Nickname Mapping (Issue #130)
 * Accepts a friendly nickname mapped to a Stellar address and echoes back
 * a confirmation. Validates presence of both fields and the address shape.
 */

const nicknames = new Map();

export function isWellFormedStellarAddress(address) {
  return typeof address === "string" && address.length === 56 && address.startsWith("G");
}

export function handleNicknameMapRequest(body) {
  if (!body || typeof body !== "object") {
    return { status: 400, payload: { error: "invalid_body" } };
  }

  const { nickname, address } = body;

  if (typeof nickname !== "string" || nickname.trim().length === 0) {
    return { status: 400, payload: { error: "nickname_required" } };
  }

  if (typeof address !== "string" || address.trim().length === 0) {
    return { status: 400, payload: { error: "address_required" } };
  }

  if (!isWellFormedStellarAddress(address)) {
    return { status: 400, payload: { error: "malformed_address" } };
  }

  nicknames.set(nickname, address);

  return {
    status: 201,
    payload: { confirmed: true, nickname, address },
  };
}

export function handleRequest(req, res, bodyData) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed. Use POST." }));
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(bodyData || "{}");
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_json" }));
    return;
  }

  const { status, payload } = handleNicknameMapRequest(parsed);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

const PORT = process.env.PORT || 4130;
if (process.argv[1] && process.argv[1].endsWith("route.mjs")) {
  const server = http.createServer((req, res) => {
    if (req.url === "/recipient-nickname" || req.url === "/") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        handleRequest(req, res, body);
      });
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });

  server.listen(PORT, () => {
    console.log(`recipient-nickname mock listening on http://localhost:${PORT}/recipient-nickname`);
  });
}
