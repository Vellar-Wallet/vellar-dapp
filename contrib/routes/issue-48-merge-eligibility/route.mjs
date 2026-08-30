// Mock GET route returning whether a sample account is eligible for a merge
// operation. No chain or DB access.
import http from "node:http";

const MERGE_ELIGIBILITY = {
  acc_1001: { eligible: true, reasons: [] },
  acc_1002: {
    eligible: false,
    reasons: ["account_has_open_trustlines", "account_has_subentries"],
  },
  acc_1003: {
    eligible: false,
    reasons: ["balance_below_reserve"],
  },
  acc_1004: { eligible: true, reasons: [] },
};

export function handleRequest({ params = {} } = {}) {
  const { accountId } = params;
  const record = accountId ? MERGE_ELIGIBILITY[accountId] : undefined;

  if (!record) {
    return {
      status: 404,
      body: {
        error: "not_found",
        message: `No merge eligibility record found for account "${accountId ?? ""}"`,
      },
    };
  }

  return {
    status: 200,
    body: {
      accountId,
      eligible: record.eligible,
      reasons: [...record.reasons],
    },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    const match = req.url.match(/^\/accounts\/([^/]+)\/merge-eligibility$/);
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
  const port = process.env.PORT || 4048;
  server.listen(port, () => {
    console.log(
      `merge-eligibility mock listening on http://localhost:${port}/accounts/:accountId/merge-eligibility`,
    );
  });
}
