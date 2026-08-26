import http from "node:http";

// Policy type definitions
const POLICY_TYPES = [
  {
    id: "spending_limit",
    name: "Spending Limit",
    description: "Controls maximum transaction amounts within time windows",
  },
  {
    id: "transfer_whitelist",
    name: "Transfer Whitelist",
    description: "Restricts transfers to approved recipients",
  },
  {
    id: "time_lock",
    name: "Time Lock",
    description: "Enforces time-based transaction restrictions",
  },
  {
    id: "multi_sig",
    name: "Multi-Signature",
    description: "Requires multiple signatures for transactions",
  },
];

// Validation rules for each policy type
const POLICY_RULES = {
  spending_limit: [
    {
      id: "minimum_amount",
      description: "Daily limit must be at least 1 XLM",
      severity: "error",
      validate: (config) => {
        const dailyLimit = Number(config.dailyLimit);
        if (isNaN(dailyLimit) || dailyLimit < 1) {
          return { passed: false, message: "Daily limit must be at least 1 XLM" };
        }
        return { passed: true, message: "Daily limit meets minimum requirement" };
      },
    },
    {
      id: "maximum_amount",
      description: "Daily limit must not exceed 1,000,000 XLM",
      severity: "error",
      validate: (config) => {
        const dailyLimit = Number(config.dailyLimit);
        if (isNaN(dailyLimit) || dailyLimit > 1000000) {
          return { passed: false, message: "Daily limit exceeds maximum of 1,000,000 XLM" };
        }
        return { passed: true, message: "Daily limit within acceptable range" };
      },
    },
    {
      id: "tx_vs_daily_limit",
      description: "Per-transaction limit must not exceed daily limit",
      severity: "error",
      validate: (config) => {
        const dailyLimit = Number(config.dailyLimit);
        const txLimit = Number(config.txLimit);
        if (!isNaN(txLimit) && !isNaN(dailyLimit) && txLimit > dailyLimit) {
          return {
            passed: false,
            message: "Per-transaction limit cannot exceed daily limit",
          };
        }
        return {
          passed: true,
          message: "Per-transaction limit properly configured",
        };
      },
    },
  ],
  transfer_whitelist: [
    {
      id: "minimum_recipients",
      description: "Must have at least 1 whitelisted recipient",
      severity: "error",
      validate: (config) => {
        const recipients = config.recipients || [];
        if (!Array.isArray(recipients) || recipients.length < 1) {
          return {
            passed: false,
            message: "At least 1 whitelisted recipient required",
          };
        }
        return {
          passed: true,
          message: `${recipients.length} recipient(s) configured`,
        };
      },
    },
    {
      id: "maximum_recipients",
      description: "Cannot exceed 100 whitelisted recipients",
      severity: "error",
      validate: (config) => {
        const recipients = config.recipients || [];
        if (Array.isArray(recipients) && recipients.length > 100) {
          return {
            passed: false,
            message: "Maximum 100 recipients allowed",
          };
        }
        return {
          passed: true,
          message: "Recipients count within limit",
        };
      },
    },
  ],
  time_lock: [
    {
      id: "minimum_delay",
      description: "Time lock delay must be at least 60 seconds",
      severity: "error",
      validate: (config) => {
        const delaySeconds = Number(config.delaySeconds);
        if (isNaN(delaySeconds) || delaySeconds < 60) {
          return {
            passed: false,
            message: "Delay must be at least 60 seconds",
          };
        }
        return {
          passed: true,
          message: "Delay meets minimum requirement",
        };
      },
    },
    {
      id: "maximum_delay",
      description: "Time lock delay must not exceed 365 days",
      severity: "error",
      validate: (config) => {
        const delaySeconds = Number(config.delaySeconds);
        const maxSeconds = 365 * 24 * 60 * 60; // 365 days
        if (isNaN(delaySeconds) || delaySeconds > maxSeconds) {
          return {
            passed: false,
            message: "Delay cannot exceed 365 days",
          };
        }
        return {
          passed: true,
          message: "Delay within acceptable range",
        };
      },
    },
  ],
  multi_sig: [
    {
      id: "minimum_signatures",
      description: "Must require at least 2 signatures",
      severity: "error",
      validate: (config) => {
        const required = Number(config.requiredSignatures);
        if (isNaN(required) || required < 2) {
          return {
            passed: false,
            message: "At least 2 signatures required",
          };
        }
        return {
          passed: true,
          message: "Signature requirement meets minimum",
        };
      },
    },
    {
      id: "maximum_signatures",
      description: "Cannot require more than 20 signatures",
      severity: "error",
      validate: (config) => {
        const required = Number(config.requiredSignatures);
        if (isNaN(required) || required > 20) {
          return {
            passed: false,
            message: "Maximum 20 signatures allowed",
          };
        }
        return {
          passed: true,
          message: "Signature requirement within limit",
        };
      },
    },
  ],
};

export class PolicyCatalog {
  listTypes() {
    return { types: POLICY_TYPES };
  }

  getRules(policyType) {
    if (!POLICY_RULES[policyType]) {
      throw new Error(`Unknown policy type: ${policyType}`);
    }

    const rules = POLICY_RULES[policyType].map((rule) => ({
      id: rule.id,
      description: rule.description,
      severity: rule.severity,
    }));

    return {
      policyType,
      rules,
    };
  }

  validate(policyType, config) {
    if (!POLICY_RULES[policyType]) {
      throw new Error(`Unknown policy type: ${policyType}`);
    }

    const rules = POLICY_RULES[policyType];
    const results = rules.map((rule) => {
      const result = rule.validate(config);
      return {
        ruleId: rule.id,
        passed: result.passed,
        message: result.message,
        severity: rule.severity,
      };
    });

    const valid = results.every((r) => r.passed);

    return {
      valid,
      results,
    };
  }
}

export function handleRequest(action, payload) {
  const catalog = new PolicyCatalog();

  try {
    switch (action) {
      case "list-types":
        return { status: 200, body: catalog.listTypes() };

      case "get-rules":
        if (!payload.policyType) {
          return {
            status: 400,
            body: { error: "policyType required" },
          };
        }
        return { status: 200, body: catalog.getRules(payload.policyType) };

      case "validate":
        if (!payload.policyType || !payload.config) {
          return {
            status: 400,
            body: { error: "policyType and config required" },
          };
        }
        return {
          status: 200,
          body: catalog.validate(payload.policyType, payload.config),
        };

      default:
        return { status: 400, body: { error: "unknown_action" } };
    }
  } catch (error) {
    return {
      status: 400,
      body: { error: error.message },
    };
  }
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

      const action = body.action || "list-types";
      const { status, body: resBody } = handleRequest(action, body);

      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resBody, null, 2));
    });
  });

  const port = process.env.PORT || 4101;
  server.listen(port, () =>
    console.log(`Policy catalog listening on port ${port}`)
  );
}
