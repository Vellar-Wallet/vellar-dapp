// Mock POST route accepting a payment request payload and echoing back a
// validation result. No chain or DB access.
import http from "node:http";

const REQUIRED_FIELDS = ["recipient", "amount", "asset"];

export function handleRequest({ body = {} } = {}) {
  const missingFields = REQUIRED_FIELDS.filter(
    (field) => body[field] === undefined || body[field] === null || body[field] === "",
  );

  if (missingFields.length > 0) {
    return {
      status: 400,
      body: {
        error: "invalid_request",
        message: `Missing required field(s): ${missingFields.join(", ")}`,
        missingFields,
      },
    };
  }

  return {
    status: 200,
    body: {
      valid: true,
      recipient: body.recipient,
      amount: body.amount,
      asset: body.asset,
    },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/payment-request") {
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
        const { status, body: responseBody } = handleRequest({ body });
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseBody));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4027;
  server.listen(port, () => {
    console.log(`payment-request mock listening on http://localhost:${port}/payment-request`);
  });
}
