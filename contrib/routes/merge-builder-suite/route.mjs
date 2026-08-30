import http from "node:http";

const VALID_DESTINATIONS = [
  "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB",
  "GDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF",
];

const FIXED_RESERVE = "1.0000000";

const SAMPLE_SOURCE = {
  account: "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB",
  balance: "1250.5000000",
};

function validateDestination(dest) {
  if (!dest) {
    return { valid: false, error: "destination_required" };
  }
  if (!VALID_DESTINATIONS.includes(dest)) {
    return { valid: false, error: "invalid_destination", destination: dest };
  }
  return { valid: true };
}

export function handleRequest(req) {
  const parsedUrl = new URL(req.url, "http://localhost");
  const path = parsedUrl.pathname;

  if (path === "/validate-destination" && req.method === "POST") {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        try {
          const body = JSON.parse(data);
          const result = validateDestination(body.destination);
          resolve({
            status: result.valid ? 200 : 400,
            body: result,
          });
        } catch {
          resolve({ status: 400, body: { error: "invalid_json" } });
        }
      });
    });
  }

  if (path === "/build" && req.method === "POST") {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        try {
          const body = JSON.parse(data);
          const destCheck = validateDestination(body.destination);
          if (!destCheck.valid) {
            resolve({ status: 400, body: destCheck });
            return;
          }
          resolve({
            status: 200,
            body: {
              source: SAMPLE_SOURCE.account,
              destination: body.destination,
              amount: SAMPLE_SOURCE.balance,
              memo: "merge",
              txReady: true,
            },
          });
        } catch {
          resolve({ status: 400, body: { error: "invalid_json" } });
        }
      });
    });
  }

  if (path === "/estimate-reclaim" && req.method === "GET") {
    const balance = parseFloat(SAMPLE_SOURCE.balance);
    const reserve = parseFloat(FIXED_RESERVE);
    const reclaimed = (balance - reserve).toFixed(7);
    return {
      status: 200,
      body: {
        source: SAMPLE_SOURCE.account,
        sourceBalance: SAMPLE_SOURCE.balance,
        reserve: FIXED_RESERVE,
        estimatedReclaim: reclaimed,
      },
    };
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
  const port = process.env.PORT || 4051;
  server.listen(port, () => {
    console.log(
      `merge-builder-suite mock listening on http://localhost:${port}`,
    );
  });
}
