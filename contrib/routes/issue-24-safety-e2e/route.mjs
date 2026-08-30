import http from "node:http";

export class SafetyPolicyE2ESimulator {
  constructor() {
    this.configuredPolicy = null;
    this.deployedContractId = null;
  }

  configurePolicy(dailyXlm) {
    if (!dailyXlm || Number(dailyXlm) <= 0) {
      throw new Error("Daily limit must be a positive number");
    }
    this.configuredPolicy = {
      type: "spending_limit",
      dailyXlm,
      status: "generated",
      wordingDescription:
        "Configures on-chain spending controls for known transfer patterns.",
    };
    return this.configuredPolicy;
  }

  deployPolicy(walletAddress) {
    if (!this.configuredPolicy) {
      throw new Error("No policy configured");
    }
    this.deployedContractId = "CBGL7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF99";
    this.configuredPolicy.status = "deployed";
    this.configuredPolicy.wallet = walletAddress;
    return {
      contractId: this.deployedContractId,
      status: "attached",
    };
  }

  attemptTransaction(amountXlm, recipient) {
    if (!this.deployedContractId) {
      throw new Error("No active safety policy attached to account");
    }

    const limit = Number(this.configuredPolicy.dailyXlm);
    if (Number(amountXlm) > limit) {
      return {
        allowed: false,
        explanation:
          "Transaction rejected: violates configured safety policy spending limit for known transfer patterns",
      };
    }
    return {
      allowed: true,
      explanation: "Transaction authorized within configured spending limit",
    };
  }

  reviewPositioningWording(userFacingStrings) {
    const prohibitedTerms = ["intent firewall", "universal protection", "fiat"];
    const issues = [];

    for (const str of userFacingStrings) {
      for (const term of prohibitedTerms) {
        if (str.toLowerCase().includes(term)) {
          issues.push(`Prohibited term '${term}' found in string: "${str}"`);
        }
      }
      if (/\$\d+/.test(str) || /USD/i.test(str)) {
        issues.push(`Fiat amount representation found in string: "${str}"`);
      }
    }

    return {
      passed: issues.length === 0,
      issues,
    };
  }
}

export function handleLifecycleRequest(action, payload) {
  const sim = new SafetyPolicyE2ESimulator();
  if (action === "full_flow") {
    const config = sim.configurePolicy(payload.dailyXlm || "50");
    const deploy = sim.deployPolicy(payload.wallet || "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67");
    const validTx = sim.attemptTransaction("20", payload.recipient || "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM");
    const invalidTx = sim.attemptTransaction("100", payload.recipient || "GCMCEGOUVALP2H6LTY7IPUUMSFKDQUMK3SDU5DI7LETNEZZKHRIIALKM");

    return {
      status: 200,
      body: {
        configured: config,
        deployed: deploy,
        validTx,
        invalidTx,
      },
    };
  }
  return { status: 400, body: { error: "unknown_action" } };
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
      const { status, body: resBody } = handleLifecycleRequest("full_flow", body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resBody));
    });
  });
  const port = process.env.PORT || 4024;
  server.listen(port, () => console.log(`safety e2e mock listening on port ${port}`));
}
