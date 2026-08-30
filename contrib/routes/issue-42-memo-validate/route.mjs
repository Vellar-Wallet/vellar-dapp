import http from "node:http";

const VALID_MEMO_TYPES = ["text", "id", "hash"];
const MAX_MEMO_BYTES = 28;

export function handleRequest(body) {
  if (!body || typeof body.memo === "undefined") {
    return { status: 400, body: { error: "memo_required" } };
  }

  const { memo, type } = body;

  if (typeof memo !== "string") {
    return { status: 400, body: { error: "memo_must_be_string" } };
  }

  const memoBytes = Buffer.byteLength(memo, "utf-8");
  if (memoBytes > MAX_MEMO_BYTES) {
    return {
      status: 400,
      body: {
        error: "memo_too_long",
        message: `Memo exceeds ${MAX_MEMO_BYTES} bytes (${memoBytes} bytes provided)`,
      },
    };
  }

  if (type && !VALID_MEMO_TYPES.includes(type)) {
    return {
      status: 400,
      body: {
        error: "invalid_memo_type",
        message: `Must be one of: ${VALID_MEMO_TYPES.join(", ")}`,
      },
    };
  }

  return { status: 200, body: { valid: true, memo, type: type || "text" } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/memo-validate") {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        try {
          const body = JSON.parse(data);
          const { status, body: resp } = handleRequest(body);
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(resp));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_json" }));
        }
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4042;
  server.listen(port, () => {
    console.log(
      `memo-validate mock listening on http://localhost:${port}/memo-validate`,
    );
  });
}
