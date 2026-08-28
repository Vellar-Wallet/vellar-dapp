// Mock GET route returning a fake account status. No chain or DB access.
import http from "node:http";
import { URL } from "node:url";

export function handleRequest({ params = {} } = {}) {
  const { accountId } = params;

  if (!accountId) {
    return {
      status: 400,
      body: { error: "invalid_request", message: "accountId path parameter is required" },
    };
  }

  return {
    status: 200,
    body: {
      accountId,
      exists: true,
      funded: true,
      sequence: "123456789012345",
    },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const match = url.pathname.match(/^\/account-status\/([^/]+)$/);
    if (req.method === "GET" && match) {
      const { status, body } = handleRequest({
        params: { accountId: decodeURIComponent(match[1]) },
      });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4028;
  server.listen(port, () => {
    console.log(
      `account-status mock listening on http://localhost:${port}/account-status/:accountId`,
    );
  });
}
