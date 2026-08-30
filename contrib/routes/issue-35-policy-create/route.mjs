// Mock POST route accepting a policy creation payload and echoing back the created
// record with a generated id. No chain or DB access — nothing is persisted.
import http from "node:http";

const VALID_TYPES = ["spending-limit", "allowlist", "velocity"];
const DEFAULT_TYPE = "spending-limit";

// Simple in-memory counter standing in for a database sequence. It resets every
// time the process restarts, which is fine for a mock.
let idCounter = 0;

function nextId() {
  idCounter += 1;
  return `pol_${String(idCounter).padStart(4, "0")}`;
}

// A field is valid when it is a finite number strictly greater than zero. Numeric
// strings are rejected on purpose so callers send real JSON numbers.
function validatePositiveNumber(value, field) {
  if (typeof value === "undefined" || value === null) {
    return { error: `${field}_required`, message: `"${field}" is required` };
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return {
      error: `${field}_invalid`,
      message: `"${field}" must be a number, received ${typeof value}`,
    };
  }
  if (value <= 0) {
    return {
      error: `${field}_invalid`,
      message: `"${field}" must be greater than 0, received ${value}`,
    };
  }
  return null;
}

export function handleRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: { error: "invalid_body", message: "Expected a JSON object" } };
  }

  const { limit, windowSeconds, type, label } = body;

  const failure =
    validatePositiveNumber(limit, "limit") ??
    validatePositiveNumber(windowSeconds, "windowSeconds");
  if (failure) {
    return { status: 400, body: failure };
  }

  if (typeof type !== "undefined" && !VALID_TYPES.includes(type)) {
    return {
      status: 400,
      body: {
        error: "invalid_type",
        message: `"type" must be one of: ${VALID_TYPES.join(", ")}`,
      },
    };
  }

  return {
    status: 201,
    body: {
      id: nextId(),
      type: type ?? DEFAULT_TYPE,
      label: label ?? null,
      limit,
      windowSeconds,
      status: "active",
      createdAt: new Date().toISOString(),
    },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/policies") {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_json" }));
          return;
        }
        const { status, body } = handleRequest(parsed);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4035;
  server.listen(port, () => {
    console.log(`policy-create mock listening on http://localhost:${port}/policies`);
  });
}
