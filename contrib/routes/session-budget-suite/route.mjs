import http from "node:http";

export class SessionBudgetTracker {
  constructor(initialBudget = 1000) {
    this.totalBudget = initialBudget;
    this.spentAmount = 0;
  }

  getRemainingBudget() {
    return this.totalBudget - this.spentAmount;
  }

  getSpent() {
    return this.spentAmount;
  }

  getTotalBudget() {
    return this.totalBudget;
  }

  spend(amount) {
    if (typeof amount !== "number" || amount <= 0) {
      return {
        success: false,
        error: "invalid_amount",
        message: "Amount must be a positive number",
        remaining: this.getRemainingBudget(),
      };
    }

    const remaining = this.getRemainingBudget();

    if (amount > remaining) {
      return {
        success: false,
        error: "insufficient_budget",
        message: `Requested amount ${amount} exceeds remaining budget ${remaining}`,
        remaining,
      };
    }

    this.spentAmount += amount;

    return {
      success: true,
      spent: amount,
      remaining: this.getRemainingBudget(),
    };
  }

  getBudgetStatus() {
    return {
      remaining: this.getRemainingBudget(),
      spent: this.spentAmount,
      total: this.totalBudget,
    };
  }

  reset(newBudget) {
    if (newBudget !== undefined) {
      this.totalBudget = newBudget;
    }
    this.spentAmount = 0;
  }
}

export function handleBudgetRequest(action, payload, tracker) {
  if (action === "spend") {
    const amount = payload?.amount;
    if (amount === undefined) {
      return {
        status: 400,
        body: {
          success: false,
          error: "missing_amount",
          message: "Amount is required",
        },
      };
    }

    const result = tracker.spend(amount);
    return {
      status: result.success ? 200 : 400,
      body: result,
    };
  }

  if (action === "remaining-budget") {
    return {
      status: 200,
      body: tracker.getBudgetStatus(),
    };
  }

  if (action === "reset") {
    tracker.reset(payload?.budget);
    return {
      status: 200,
      body: {
        success: true,
        message: "Budget reset successfully",
        ...tracker.getBudgetStatus(),
      },
    };
  }

  return {
    status: 400,
    body: {
      error: "unknown_action",
      message: `Unknown action: ${action}`,
    },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const initialBudget = process.env.INITIAL_BUDGET
    ? parseInt(process.env.INITIAL_BUDGET, 10)
    : 1000;

  const tracker = new SessionBudgetTracker(initialBudget);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    let bodyStr = "";
    req.on("data", (chunk) => (bodyStr += chunk));
    req.on("end", () => {
      let body = {};
      try {
        if (bodyStr) body = JSON.parse(bodyStr);
      } catch {}

      let action;
      if (pathname === "/spend" && req.method === "POST") {
        action = "spend";
      } else if (pathname === "/remaining-budget" && req.method === "GET") {
        action = "remaining-budget";
      } else if (pathname === "/reset" && req.method === "POST") {
        action = "reset";
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "not_found",
            message: `Endpoint ${pathname} not found`,
          })
        );
        return;
      }

      const { status, body: resBody } = handleBudgetRequest(action, body, tracker);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resBody));
    });
  });

  const port = process.env.PORT || 4100;
  server.listen(port, () =>
    console.log(
      `Session budget tracker listening on port ${port} (initial budget: ${initialBudget})`
    )
  );
}
