import http from "node:http";

export class GatewayAlertMonitor {
  constructor(thresholdPercent = 5.0, windowSeconds = 60) {
    this.thresholdPercent = thresholdPercent;
    this.windowSeconds = windowSeconds;
    this.requests = [];
    this.alertsFired = [];
  }

  recordRequest(statusCode, timestamp = Date.now()) {
    this.requests.push({ statusCode, timestamp });
    this.pruneOldRequests(timestamp);
  }

  pruneOldRequests(now = Date.now()) {
    const cutoff = now - this.windowSeconds * 1000;
    this.requests = this.requests.filter((r) => r.timestamp >= cutoff);
  }

  evaluateAlert(now = Date.now()) {
    this.pruneOldRequests(now);
    if (this.requests.length === 0) {
      return { triggered: false, errorRatePercent: 0 };
    }

    const total = this.requests.length;
    const errors5xx = this.requests.filter(
      (r) => r.statusCode >= 500 && r.statusCode <= 599,
    ).length;
    const errorRatePercent = (errors5xx / total) * 100;

    if (errorRatePercent > this.thresholdPercent) {
      const alertPayload = {
        alert: "ApiGatewayElevated5xxRate",
        severity: "critical",
        service: "api-gateway",
        thresholdPercent: this.thresholdPercent,
        currentRatePercent: Number(errorRatePercent.toFixed(2)),
        totalRequestsInWindow: total,
        errorRequestsInWindow: errors5xx,
        channel: "#on-call-incidents",
        runbookUrl: "https://docs.vellar.internal/runbooks/api-gateway-5xx-elevated-rate",
        timestamp: new Date(now).toISOString(),
      };
      this.alertsFired.push(alertPayload);
      return { triggered: true, alert: alertPayload, errorRatePercent };
    }

    return { triggered: false, errorRatePercent };
  }
}

export function handleRequest(req) {
  const monitor = new GatewayAlertMonitor();
  if (req.body?.syntheticLoad) {
    for (let i = 0; i < 90; i++) monitor.recordRequest(200);
    for (let i = 0; i < 10; i++) monitor.recordRequest(500); // 10% error rate
  }
  const evalResult = monitor.evaluateAlert();
  return {
    status: evalResult.triggered ? 200 : 200,
    body: evalResult,
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    let bodyStr = "";
    req.on("data", (chunk) => (bodyStr += chunk));
    req.on("end", () => {
      let body = {};
      try {
        if (bodyStr) body = JSON.parse(bodyStr);
      } catch {}
      const { status, body: resBody } = handleRequest({ method: req.method, body });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resBody));
    });
  });
  const port = process.env.PORT || 4305;
  server.listen(port, () => console.log(`issue-305 mock listening on port ${port}`));
}
