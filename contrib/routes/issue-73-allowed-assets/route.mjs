import http from "node:http";

/**
 * Mock Route / Validator Module: Allowed Assets Validation (Issue #73)
 * Validates allowedAssets array configuration for wallet policies.
 */
export const ALLOWED_ASSET_TYPES = ["native", "credit_alphanum4", "credit_alphanum12"];

export function validateAllowedAssetsConfig(allowedAssets) {
  if (!Array.isArray(allowedAssets)) {
    return { valid: false, reason: "'allowedAssets' must be an array" };
  }

  for (const asset of allowedAssets) {
    if (!asset || typeof asset !== "object") {
      return { valid: false, reason: "Each asset entry must be an object" };
    }
    if (!asset.code || typeof asset.code !== "string") {
      return { valid: false, reason: "Asset missing valid 'code' property" };
    }
    if (!ALLOWED_ASSET_TYPES.includes(asset.type)) {
      return { valid: false, reason: `Invalid asset type '${asset.type}'. Expected one of: ${ALLOWED_ASSET_TYPES.join(", ")}` };
    }
  }

  return { valid: true };
}

export function handleAllowedAssetsRequest(req, res, bodyData) {
  if (req.method === "POST") {
    try {
      const payload = JSON.parse(bodyData || "{}");
      const result = validateAllowedAssetsConfig(payload.allowedAssets);
      
      res.writeHead(result.valid ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ...result,
        count: Array.isArray(payload.allowedAssets) ? payload.allowedAssets.length : 0
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

const PORT = process.env.PORT || 4073;
if (process.argv[1] && process.argv[1].endsWith("route.mjs")) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => { handleAllowedAssetsRequest(req, res, body); });
  });

  server.listen(PORT, () => {
    console.log(`allowed-assets mock listening on http://localhost:${PORT}/allowed-assets`);
  });
}
