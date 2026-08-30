// Mock GET route reporting sample rate limit values as JSON body fields,
// mirroring the usual X-RateLimit-* response headers. No chain or DB access.
import http from "node:http";
import { pathToFileURL } from "node:url";

// Quota for the sample client: 1000 calls per fixed 60 second window.
const LIMIT = 1000;
const WINDOW_SECONDS = 60;
const CONSUMED = 13;

// Start of the window after the one containing `nowMs`. Windows are aligned to
// the Unix epoch, so the value is stable for every caller inside a window.
function nextWindowStart(nowMs) {
  const windowMs = WINDOW_SECONDS * 1000;
  return new Date(Math.floor(nowMs / windowMs) * windowMs + windowMs);
}

export function handleRequest({ now = Date.now() } = {}) {
  return {
    status: 200,
    body: {
      limit: LIMIT,
      remaining: LIMIT - CONSUMED,
      resetAt: nextWindowStart(now).toISOString(),
    },
  };
}

// pathToFileURL rather than a `file://` template: on Windows argv[1] is a
// drive path, which does not compare equal to import.meta.url otherwise.
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/rate-limit-info") {
      const { status, body } = handleRequest();
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4153;
  server.listen(port, () => {
    console.log(`rate-limit-info mock listening on http://localhost:${port}/rate-limit-info`);
  });
}
