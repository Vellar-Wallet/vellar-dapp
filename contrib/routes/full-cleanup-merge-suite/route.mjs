import http from "node:http";

const CLEANUP_STEPS = [
  { id: "clear-flags", description: "Clear account flags", required: true },
  {
    id: "remove-trustlines",
    description: "Remove extra trustlines",
    required: true,
  },
  { id: "lower-signers", description: "Reduce signer count to 1", required: true },
];

const SAMPLE_ACCOUNTS = {
  "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB": {
    account: "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB",
    balance: "1250.5000000",
    flags: 1,
    trustlines: 3,
    signers: 2,
  },
};

const accountState = new Map();

function getState(accountId) {
  if (!accountState.has(accountId)) {
    accountState.set(accountId, { completedSteps: [] });
  }
  return accountState.get(accountId);
}

function inspectAccount(accountId) {
  const acct = SAMPLE_ACCOUNTS[accountId];
  if (!acct) return null;
  const issues = [];
  if (acct.flags !== 0) issues.push("clear-flags");
  if (acct.trustlines > 1) issues.push("remove-trustlines");
  if (acct.signers > 1) issues.push("lower-signers");
  return {
    account: acct,
    pendingSteps: CLEANUP_STEPS.filter((s) => issues.includes(s.id)).map(
      (s) => ({ id: s.id, description: s.description }),
    ),
  };
}

function executeStep(accountId, stepId) {
  const acct = SAMPLE_ACCOUNTS[accountId];
  if (!acct) return { error: "account_not_found" };
  const step = CLEANUP_STEPS.find((s) => s.id === stepId);
  if (!step) return { error: "unknown_step", stepId };
  const state = getState(accountId);
  if (state.completedSteps.includes(stepId)) {
    return { alreadyCompleted: true, stepId };
  }
  state.completedSteps.push(stepId);
  return { completed: true, stepId };
}

function checkReady(accountId) {
  const acct = SAMPLE_ACCOUNTS[accountId];
  if (!acct) return { error: "account_not_found" };
  const state = getState(accountId);
  const requiredSteps = CLEANUP_STEPS.filter((s) => s.required).map(
    (s) => s.id,
  );
  const missing = requiredSteps.filter(
    (s) => !state.completedSteps.includes(s),
  );
  return {
    ready: missing.length === 0,
    completedSteps: state.completedSteps,
    missingSteps: missing,
  };
}

export function handleRequest(req) {
  const parsedUrl = new URL(req.url, "http://localhost");
  const path = parsedUrl.pathname;

  if (path === "/inspect" && req.method === "GET") {
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

  if (path === "/execute-cleanup-step" && req.method === "POST") {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        try {
          const body = JSON.parse(data);
          if (!body.account || !body.step) {
            resolve({ status: 400, body: { error: "account_and_step_required" } });
            return;
          }
          const result = executeStep(body.account, body.step);
          if (result.error) {
            resolve({ status: 400, body: result });
          } else {
            resolve({ status: 200, body: result });
          }
        } catch {
          resolve({ status: 400, body: { error: "invalid_json" } });
        }
      });
    });
  }

  if (path === "/check-ready" && req.method === "GET") {
    const accountId = parsedUrl.searchParams.get("account");
    if (!accountId) {
      return { status: 400, body: { error: "account_required" } };
    }
    const result = checkReady(accountId);
    if (result.error) {
      return { status: 400, body: result };
    }
    return { status: 200, body: result };
  }

  if (path === "/build-merge" && req.method === "POST") {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        try {
          const body = JSON.parse(data);
          if (!body.account) {
            resolve({ status: 400, body: { error: "account_required" } });
            return;
          }
          const ready = checkReady(body.account);
          if (ready.error) {
            resolve({ status: 400, body: ready });
            return;
          }
          if (!ready.ready) {
            resolve({
              status: 400,
              body: {
                error: "not_ready",
                missingSteps: ready.missingSteps,
              },
            });
            return;
          }
          const acct = SAMPLE_ACCOUNTS[body.account];
          resolve({
            status: 200,
            body: {
              account: body.account,
              balance: acct.balance,
              mergeTx: { memo: "cleanup-merge", ready: true },
            },
          });
        } catch {
          resolve({ status: 400, body: { error: "invalid_json" } });
        }
      });
    });
  }

  return { status: 404, body: { error: "not_found" } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer(async (req, res) => {
    const { status, body } = await handleRequest(req);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const port = process.env.PORT || 4053;
  server.listen(port, () => {
    console.log(
      `full-cleanup-merge-suite mock listening on http://localhost:${port}`,
    );
  });
}
