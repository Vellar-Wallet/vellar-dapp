import http from "node:http";
import crypto from "node:crypto";

/**
 * Mock Route Suite: Cleanup Planning With Ordered Blockers (Issue #93)
 *
 * Inspects a sample account, plans a cleanup as a chain of dependent steps, and
 * lets a caller mark those steps complete — but only in order.
 *
 * The ordering is a real dependency chain, not a display preference. Each step
 * carries `dependsOn`, the id of the step immediately before it, and a step is
 * only completable once that dependency is done. Marking a step out of order is
 * refused with 409 and changes nothing, so a caller cannot skip ahead to
 * `finalize` and claim a cleanup that never happened.
 *
 * Sample accounts and their findings live in SAMPLE_ACCOUNTS below; that table
 * is the whole data source.
 */

/** Step kinds, in the order they must be executed when present. */
const STEP_CATALOG = [
  {
    kind: "cancel-offers",
    title: "Cancel open offers",
    // Offers must go first: they hold reserves and can re-fund trustlines that
    // a later step is trying to close.
    reason: "Open offers hold reserves and can refill balances a later step clears",
    describe: (account) => `Cancel ${account.openOffers} open offer(s)`,
    applies: (account) => account.openOffers > 0,
  },
  {
    kind: "drain-balances",
    title: "Drain non-native balances",
    reason: "A trustline cannot be closed while it still holds a balance",
    describe: (account) => `Move out ${account.fundedTrustlines} funded trustline balance(s)`,
    applies: (account) => account.fundedTrustlines > 0,
  },
  {
    kind: "close-trustlines",
    title: "Close trustlines",
    reason: "Each trustline holds a base reserve that the account cannot release",
    describe: (account) => `Close ${account.trustlines} trustline(s)`,
    applies: (account) => account.trustlines > 0,
  },
  {
    kind: "remove-signers",
    title: "Remove extra signers",
    reason: "Extra signers hold reserves and can block a single-key finalize",
    describe: (account) => `Remove ${account.extraSigners} extra signer(s)`,
    applies: (account) => account.extraSigners > 0,
  },
  {
    kind: "clear-flags",
    title: "Clear account flags",
    reason: "Auth flags must be cleared before the account can be finalized",
    describe: () => "Clear the account's auth flags",
    applies: (account) => account.flags !== 0,
  },
  {
    kind: "finalize",
    title: "Finalize cleanup",
    reason: "Confirms every preceding step landed",
    describe: () => "Verify the account is clean",
    // Always present, and always last — it is the step that means "done".
    applies: () => true,
  },
];

const SAMPLE_ACCOUNTS = {
  GA_DIRTY: {
    account: "GA_DIRTY",
    balance: "1250.5000000",
    openOffers: 2,
    fundedTrustlines: 1,
    trustlines: 3,
    extraSigners: 2,
    flags: 1,
  },
  GA_PARTIAL: {
    account: "GA_PARTIAL",
    balance: "80.0000000",
    openOffers: 0,
    fundedTrustlines: 0,
    trustlines: 1,
    extraSigners: 0,
    flags: 0,
  },
  GA_CLEAN: {
    account: "GA_CLEAN",
    balance: "12.0000000",
    openOffers: 0,
    fundedTrustlines: 0,
    trustlines: 0,
    extraSigners: 0,
    flags: 0,
  },
};

/** planId -> plan */
const plans = new Map();

/** Clears every stored plan. Exported for tests. */
export function resetState() {
  plans.clear();
}

function findingsFor(account) {
  return STEP_CATALOG.filter((step) => step.kind !== "finalize" && step.applies(account)).map(
    (step) => ({ kind: step.kind, detail: step.describe(account) }),
  );
}

/** `GET /inspect?account=<id>` — the sample account plus what needs cleaning. */
export function inspect(accountId) {
  const account = SAMPLE_ACCOUNTS[accountId];
  if (!account) {
    return {
      status: 404,
      payload: {
        error: "account_not_found",
        requested: accountId ?? null,
        knownAccounts: Object.keys(SAMPLE_ACCOUNTS),
      },
    };
  }

  const findings = findingsFor(account);
  return {
    status: 200,
    payload: { account, findings, needsCleanup: findings.length > 0 },
  };
}

/**
 * `POST /plan` — build the ordered plan for an account.
 *
 * Steps are numbered from 1 and chained: `dependsOn` points at the previous
 * step's id, so the chain stays intact even when a step is skipped because it
 * does not apply to this account.
 */
export function createPlan({ account: accountId } = {}) {
  const account = SAMPLE_ACCOUNTS[accountId];
  if (!account) {
    return {
      status: 404,
      payload: {
        error: "account_not_found",
        requested: accountId ?? null,
        knownAccounts: Object.keys(SAMPLE_ACCOUNTS),
      },
    };
  }

  const planId = crypto.randomUUID();
  const steps = STEP_CATALOG.filter((step) => step.applies(account)).map((step, index) => ({
    id: step.kind,
    order: index + 1,
    title: step.title,
    detail: step.describe(account),
    reason: step.reason,
    dependsOn: null, // filled in below, once the surviving order is known
    status: "pending",
    completedAt: null,
  }));

  for (let i = 1; i < steps.length; i += 1) {
    steps[i].dependsOn = steps[i - 1].id;
  }

  const plan = { planId, account: accountId, steps, createdAt: new Date().toISOString() };
  plans.set(planId, plan);

  return { status: 201, payload: planView(plan) };
}

function nextStep(plan) {
  return plan.steps.find((step) => step.status === "pending") ?? null;
}

function planView(plan) {
  const next = nextStep(plan);
  return {
    planId: plan.planId,
    account: plan.account,
    steps: plan.steps.map((step) => ({ ...step })),
    completedCount: plan.steps.filter((step) => step.status === "complete").length,
    totalSteps: plan.steps.length,
    nextStep: next ? next.id : null,
    complete: next === null,
  };
}

/** `GET /plan/:planId` — the plan as it stands, including the next step due. */
export function getPlan(planId) {
  const plan = plans.get(planId);
  if (!plan) return { status: 404, payload: { error: "plan_not_found", planId: planId ?? null } };
  return { status: 200, payload: planView(plan) };
}

/**
 * `POST /plan/:planId/complete` — mark one step complete.
 *
 * Only the next pending step is accepted. Anything else is refused and the plan
 * is left exactly as it was.
 */
export function completeStep(planId, { step: stepId } = {}) {
  const plan = plans.get(planId);
  if (!plan) return { status: 404, payload: { error: "plan_not_found", planId: planId ?? null } };

  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) {
    return {
      status: 404,
      payload: {
        error: "step_not_in_plan",
        requested: stepId ?? null,
        planSteps: plan.steps.map((candidate) => candidate.id),
      },
    };
  }

  if (step.status === "complete") {
    return {
      status: 409,
      payload: { error: "step_already_complete", step: step.id, ...planView(plan) },
    };
  }

  const expected = nextStep(plan);
  if (expected && step.id !== expected.id) {
    return {
      status: 409,
      payload: {
        error: "step_out_of_order",
        expected: expected.id,
        received: step.id,
        blockedBy: step.dependsOn,
        ...planView(plan),
      },
    };
  }

  step.status = "complete";
  step.completedAt = new Date().toISOString();

  return { status: 200, payload: { completed: step.id, ...planView(plan) } };
}

export function handleRequest(method, pathname, body, query) {
  const parts = pathname.split("/").filter(Boolean);

  if (method === "GET" && parts[0] === "inspect" && parts.length === 1) {
    return inspect(query?.account);
  }
  if (method === "POST" && parts[0] === "plan" && parts.length === 1) {
    return createPlan(body ?? {});
  }
  if (method === "GET" && parts[0] === "plan" && parts.length === 2) {
    return getPlan(parts[1]);
  }
  if (method === "POST" && parts[0] === "plan" && parts[2] === "complete" && parts.length === 3) {
    return completeStep(parts[1], body ?? {});
  }

  return { status: 404, payload: { error: "not_found" } };
}

const PORT = process.env.PORT || 4093;
if (process.argv[1] && process.argv[1].endsWith("route.mjs")) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const url = new URL(req.url, "http://localhost");
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const query = Object.fromEntries(url.searchParams);
      const { status, payload } = handleRequest(req.method, url.pathname, body, query);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  server.listen(PORT, () => {
    console.log(`cleanup-planning-suite mock listening on http://localhost:${PORT}/inspect`);
  });
}
