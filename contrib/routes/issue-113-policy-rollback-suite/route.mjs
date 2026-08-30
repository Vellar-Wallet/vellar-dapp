import http from "node:http";

let activeVersion = "v1.0.0";
let previousVersion = null;
let lastDeployResult = null;

function deploy(body) {
  const { version = "v2.0.0", fail = false } = body || {};
  previousVersion = activeVersion;
  if (fail) {
    lastDeployResult = { status: "failed", version, activeVersion };
    return { status: 200, body: { deployed: false, reason: "simulated_failure", activeVersion } };
  }
  activeVersion = version;
  lastDeployResult = { status: "success", version, activeVersion };
  return { status: 200, body: { deployed: true, version, activeVersion } };
}

function deployStatus() {
  if (!lastDeployResult) {
    return { status: 200, body: { status: "no_deploy_yet", activeVersion } };
  }
  return { status: 200, body: { ...lastDeployResult, activeVersion } };
}

function rollback() {
  if (!previousVersion) {
    return { status: 200, body: { rolledBack: false, reason: "no_previous_version", activeVersion } };
  }
  const rolledTo = previousVersion;
  activeVersion = previousVersion;
  previousVersion = null;
  lastDeployResult = null;
  return { status: 200, body: { rolledBack: true, activeVersion, rolledTo } };
}

export function handleRequest(method, url, body) {
  if (method === "POST" && url === "/deploy") return deploy(body);
  if (method === "GET" && url === "/deploy-status") return deployStatus();
  if (method === "POST" && url === "/rollback") return rollback();
  return { status: 404, body: { error: "not_found" } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : undefined;
      const { status, body: resp } = handleRequest(req.method, req.url, parsed);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resp));
    });
  });
  const port = process.env.PORT || 4113;
  server.listen(port, () => {
    console.log(`policy-rollback mock listening on http://localhost:${port}`);
  });
}
