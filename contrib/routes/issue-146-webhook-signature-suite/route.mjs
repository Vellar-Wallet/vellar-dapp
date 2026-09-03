// Mock route suite simulating a webhook delivery signed with a rotating
// secret. In-memory only, no chain, RPC, or database access. State resets
// whenever the process restarts.
import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";

const SIGNATURE_HEADER = "x-vellar-signature";
const INITIAL_SECRET = "vellar_sample_webhook_secret_v1";

// Active secret, plus history of prior secrets kept only so verify can
// report *why* an old signature fails (still rejected, never accepted).
let activeSecret = INITIAL_SECRET;
let rotationCount = 0;
let deliveries = [];

export function resetState() {
  activeSecret = INITIAL_SECRET;
  rotationCount = 0;
  deliveries = [];
}

export function currentSecret() {
  return activeSecret;
}

// Signature over the canonical `id.event` string, keyed by a given secret
// (defaults to the currently active one). Deliberately simple: the point is
// to exercise rotation and verification, not to model a production signing
// scheme.
export function signPayload(payload, secret = activeSecret) {
  return crypto.createHmac("sha256", secret).update(`${payload.id}.${payload.event}`).digest("hex");
}

function signatureMatches(expected, provided) {
  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(String(provided), "utf8");
  if (expectedBytes.length !== providedBytes.length) return false;
  return crypto.timingSafeEqual(expectedBytes, providedBytes);
}

function isValidPayload(body) {
  return Boolean(body) && typeof body.id === "string" && typeof body.event === "string";
}

// POST /webhook/deliver — simulate a webhook delivery signed with the
// currently active secret. Records the delivery so /webhook/verify can
// re-check it later (e.g. after a rotation).
export function deliver({ headers = {}, body = {} } = {}) {
  const signature = headers[SIGNATURE_HEADER] ?? headers[SIGNATURE_HEADER.toUpperCase()];

  if (!isValidPayload(body)) {
    return {
      status: 400,
      body: { error: "invalid_payload", message: "payload requires string id and event fields" },
    };
  }
  if (typeof signature !== "string" || signature === "") {
    return {
      status: 401,
      body: { error: "missing_signature", message: `${SIGNATURE_HEADER} header is required` },
    };
  }
  if (!signatureMatches(signPayload(body), signature)) {
    return { status: 401, body: { error: "invalid_signature" } };
  }

  deliveries.push({ id: body.id, event: body.event, signature });
  return {
    status: 202,
    body: { delivered: true, id: body.id, event: body.event, deliveredCount: deliveries.length },
  };
}

// POST /webhook/rotate-secret — replace the active secret with a fresh
// generated one. Signatures produced under the old secret stop verifying.
export function rotateSecret() {
  activeSecret = crypto.randomBytes(16).toString("hex");
  rotationCount += 1;
  return {
    status: 200,
    body: { rotated: true, rotationCount },
  };
}

// POST /webhook/verify — check a payload + signature against the
// currently active secret only. A signature produced under a previous
// secret fails once rotation has happened, regardless of whether the
// payload was actually delivered.
export function verify({ body = {}, signature } = {}) {
  if (!isValidPayload(body)) {
    return {
      status: 400,
      body: { error: "invalid_payload", message: "payload requires string id and event fields" },
    };
  }
  if (typeof signature !== "string" || signature === "") {
    return {
      status: 401,
      body: { error: "missing_signature", message: "signature field is required" },
    };
  }

  const valid = signatureMatches(signPayload(body), signature);
  return {
    status: valid ? 200 : 401,
    body: valid
      ? { verified: true, id: body.id, event: body.event }
      : { verified: false, error: "invalid_signature" },
  };
}

export function handleRequest({ method = "GET", path = "", headers = {}, body = {} } = {}) {
  if (path === "/webhook/deliver") {
    return method === "POST"
      ? deliver({ headers, body })
      : { status: 405, body: { error: "method_not_allowed" } };
  }
  if (path === "/webhook/rotate-secret") {
    return method === "POST"
      ? rotateSecret()
      : { status: 405, body: { error: "method_not_allowed" } };
  }
  if (path === "/webhook/verify") {
    return method === "POST"
      ? verify({ body: body.payload, signature: body.signature })
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

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const body = await readJsonBody(req);
    const result =
      body === null
        ? { status: 400, body: { error: "invalid_json" } }
        : handleRequest({ method: req.method, path: url.pathname, headers: req.headers, body });
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  const port = process.env.PORT || 4146;
  server.listen(port, () => {
    console.log(`webhook-signature-suite listening on http://localhost:${port}`);
    console.log(`  POST /webhook/deliver         header: ${SIGNATURE_HEADER}`);
    console.log(`  POST /webhook/rotate-secret`);
    console.log(`  POST /webhook/verify           body: { payload, signature }`);
  });
}
