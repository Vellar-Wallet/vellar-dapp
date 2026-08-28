import http from "node:http";

const TEMPLATE_VERSIONS = [
  {
    version: "1.0",
    fields: { policyName: "name", maxSigners: "signerLimit", network: "chain" },
  },
  {
    version: "1.1",
    fields: {
      policyName: "policyName",
      maxSigners: "maxSigners",
      network: "network",
    },
  },
  {
    version: "2.0",
    fields: {
      policyName: "policyName",
      maxSigners: "maxSigners",
      network: "network",
      expiry: "expiry",
    },
  },
];

const CURRENT_VERSION = "2.0";
const FIELD_MIGRATIONS = {
  "1.0": { name: "policyName", signerLimit: "maxSigners", chain: "network" },
  "1.1": {},
};

function getCurrentConfig() {
  const current = TEMPLATE_VERSIONS.find((v) => v.version === CURRENT_VERSION);
  return {
    version: current.version,
    fields: Object.keys(current.fields),
  };
}

function migrate(config) {
  if (!config || !config.version) {
    return { error: "version_required" };
  }
  if (config.version === CURRENT_VERSION) {
    return { migrated: false, config, reason: "already_current" };
  }
  const migration = FIELD_MIGRATIONS[config.version];
  if (!migration) {
    return { error: "unknown_version", version: config.version };
  }
  const newConfig = { ...config, version: CURRENT_VERSION };
  for (const [oldKey, newKey] of Object.entries(migration)) {
    if (oldKey in newConfig) {
      newConfig[newKey] = newConfig[oldKey];
      delete newConfig[oldKey];
    }
  }
  return { migrated: true, config: newConfig };
}

export function handleRequest(req) {
  const parsedUrl = new URL(req.url, "http://localhost");
  const path = parsedUrl.pathname;

  if (path === "/versions" && req.method === "GET") {
    return {
      status: 200,
      body: {
        versions: TEMPLATE_VERSIONS.map((v) => v.version),
        current: CURRENT_VERSION,
      },
    };
  }

  if (path === "/current-config" && req.method === "GET") {
    return { status: 200, body: getCurrentConfig() };
  }

  if (path === "/migrate" && req.method === "POST") {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        try {
          const body = JSON.parse(data);
          const result = migrate(body);
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

  return { status: 404, body: { error: "not_found" } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer(async (req, res) => {
    const { status, body } = await handleRequest(req);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const port = process.env.PORT || 4052;
  server.listen(port, () => {
    console.log(
      `template-versioning-suite mock listening on http://localhost:${port}`,
    );
  });
}
