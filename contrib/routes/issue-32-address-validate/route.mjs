import http from "node:http";

/**
 * Mock POST Route: Address Validation (Issue #32)
 * Validates Stellar public key address format (starts with 'G' and 56 chars long).
 */
export function validateStellarAddress(address) {
  if (typeof address !== "string") {
    return { valid: false, reason: "Address must be a string" };
  }

  if (address.length !== 56) {
    return { valid: false, reason: `Invalid address length (expected 56 characters, got ${address.length})` };
  }

  if (!address.startsWith("G")) {
    return { valid: false, reason: "Public key address must start with 'G'" };
  }

  return { valid: true };
}

export function handleAddressValidateRequest(req, res, bodyData) {
  if (req.method === "POST") {
    try {
      const payload = JSON.parse(bodyData || "{}");
      const result = validateStellarAddress(payload.address);
      
      res.writeHead(result.valid ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ...result,
        address: payload.address || null
      }));
      return;
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ valid: false, reason: "Invalid JSON payload" }));
      return;
    }
  }

  res.writeHead(405, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Method not allowed. Use POST." }));
}

const PORT = process.env.PORT || 4032;
if (process.argv[1] && process.argv[1].endsWith("route.mjs")) {
  const server = http.createServer((req, res) => {
    if (req.url === "/address-validate" || req.url === "/") {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => { handleAddressValidateRequest(req, res, body); });
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });

  server.listen(PORT, () => {
    console.log(`address-validate mock listening on http://localhost:${PORT}/address-validate`);
  });
}
