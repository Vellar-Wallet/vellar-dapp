// Mock route suite verifying a webhook signature and rejecting replays.
// The shared secret below is a fixed sample value for local testing only —
// it is not a credential. No chain, RPC, or database access; processed ids
// are held in memory for the lifetime of the process.
import http from "node:http";
import crypto from "node:crypto";
import { URL, pathToFileURL } from "node:url";

// Sample shared secret. A real deployment would read this from config.
export const SHARED_SECRET = "vellar_sample_webhook_secret";

const SIGNATURE_HEADER = "x-vellar-signature";

// Processed payload ids, newest last, used for replay rejection.
let processed = [];

export function resetState() {
  processed = [];
}

// Signature over the canonical `id.event` string. Deliberately simple: the
// point is to exercise the accept/reject paths, not to model a production
// signing scheme.
export function signPayload(payload, secret = SHARED_SECRET) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${payload.id}.${payload.event}`)
    .digest("hex");
}

function signatureMatches(expected, provided) {
  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(String(provided), "utf8");
  if (expectedBytes.length !== providedBytes.length) return false;
  return crypto.timingSafeEqual(expectedBytes, providedBytes);
}

export function receive({ headers = {}, body = {} } = {}) {
  const signature =
    headers[SIGNATURE_HEADER] ?? headers[SIGNATURE_HEADER.toUpperCase()];

  if (!body || typeof body.id !== "string" || typeof body.event !== "string") {
    return {
      status: 400,
      body: {
        error: "invalid_payload",
        message: "payload requires string id and event fields",
      },
    };
  }
  if (typeof signature !== "string" || signature === "") {
    return {
      status: 401,
      body: {
        error: "missing_signature",
        message: `${SIGNATURE_HEADER} header is required`,
      },
    };
  }
  if (!signatureMatches(signPayload(body), signature)) {
    return {
      status: 401,
      body: {
        error: "invalid_signature",
        message: "signature does not match the shared secret",
      },
    };
  }
  // Signature checked before replay, so a forged delivery never reveals
  // whether an id has been seen.
  if (processed.includes(body.id)) {
    return {
      status: 409,
      body: {
        error: "replay_detected",
        message: `payload ${body.id} was already processed`,
        id: body.id,
      },
    };
  }

  processed.push(body.id);
  return {
    status: 202,
    body: {
      accepted: true,
      id: body.id,
      event: body.event,
      processedCount: processed.length,
    },
  };
}

export function processedIds() {
  return {
    status: 200,
    body: { ids: [...processed], count: processed.length },
  };
}

export function handleRequest({
  method = "GET",
  path = "",
  headers = {},
  body = {},
} = {}) {
  if (path === "/webhook/receive") {
    return method === "POST"
      ? receive({ headers, body })
      : { status: 405, body: { error: "method_not_allowed" } };
  }
  if (path === "/webhook/processed-ids") {
    return method === "GET"
      ? processedIds()
      : { status: 405, body: { error: "method_not_allowed" } };
  }
  return { status: 404, body: { error: "not_found" } };
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
  });
}

// pathToFileURL keeps this check correct on Windows paths; argv[1] is
// undefined when the module is imported rather than executed.
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
const isMain = entry !== null && import.meta.url === entry;
if (isMain) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const body = await readJsonBody(req);
    const result =
      body === null
        ? { status: 400, body: { error: "invalid_json" } }
        : handleRequest({
            method: req.method,
            path: url.pathname,
            headers: req.headers,
            body,
          });
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  const port = process.env.PORT || 4116;
  server.listen(port, () => {
    console.log(`webhook-signature suite listening on http://localhost:${port}`);
    console.log(`  POST /webhook/receive       header: ${SIGNATURE_HEADER}`);
    console.log(`  GET  /webhook/processed-ids`);
  });
}
