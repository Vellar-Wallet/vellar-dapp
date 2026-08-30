import http from "node:http";

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

const SAMPLE_ACCOUNTS = {
  "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB": {
    account: "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB",
    balance: "1250.5000000",
    trustlines: 3,
    signers: 1,
    flags: 0,
  },
  "GDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF": {
    account: "GDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF",
    balance: "0.5000000",
    trustlines: 3,
    signers: 2,
    flags: 1,
  },
};

function inspectAccount(accountId) {
  if (!SAMPLE_ACCOUNTS[accountId]) {
    return null;
  }
  const acct = SAMPLE_ACCOUNTS[accountId];
  const blockers = [];

  if (parseFloat(acct.balance) < 1) {
    blockers.push({
      id: "low-balance",
      severity: "high",
      message: "Account balance is below minimum reserve",
    });
  }
  if (acct.trustlines > 2) {
    blockers.push({
      id: "excess-trustlines",
      severity: "medium",
      message: "Account has more than 2 trustlines",
    });
  }
  if (acct.flags !== 0) {
    blockers.push({
      id: "account-flagged",
      severity: "low",
      message: "Account has flags set",
    });
  }
  if (acct.signers > 1) {
    blockers.push({
      id: "multiple-signers",
      severity: "medium",
      message: "Account has multiple signers",
    });
  }

  return { account: acct, blockers };
}

export function handleRequest(url) {
  const parsedUrl = new URL(url, "http://localhost");
  const path = parsedUrl.pathname;

  if (path === "/inspect") {
    const accountId = parsedUrl.searchParams.get("account");
    if (!accountId) {
      return { status: 400, body: { error: "account_required" } };
    }
    const result = inspectAccount(accountId);
    if (!result) {
      return { status: 404, body: { error: "account_not_found" } };
    }
    return { status: 200, body: result };
  }

  if (path === "/report") {
    const accountId = parsedUrl.searchParams.get("account");
    if (!accountId) {
      return { status: 400, body: { error: "account_required" } };
    }
    const result = inspectAccount(accountId);
    if (!result) {
      return { status: 404, body: { error: "account_not_found" } };
    }
    const sorted = [...result.blockers].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );
    return {
      status: 200,
      body: { account: accountId, blockers: sorted },
    };
  }

  return { status: 404, body: { error: "not_found" } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    const { status, body } = handleRequest(req.url);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const port = process.env.PORT || 4050;
  server.listen(port, () => {
    console.log(
      `blocker-report-suite mock listening on http://localhost:${port}`,
    );
  });
}
