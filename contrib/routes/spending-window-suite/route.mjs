import http from "node:http";

/**
 * Mock Route Suite: Rolling Window Spending Limit Reset (Issue #98)
 *
 * Tracks cumulative sample spend per account inside a rolling window and resets
 * that window once it elapses.
 *
 * The window is anchored, not sliding: it opens on the first spend an account
 * makes and runs for exactly WINDOW_MS from that instant. Every spend inside it
 * accumulates against the same total. The first spend at or after the window's
 * end opens a fresh window anchored at that spend, with the total back at zero.
 *
 * Two consequences worth naming, because they are what the tests pin down:
 *   - A rejected spend changes nothing. It is not recorded and it does not
 *     extend or re-anchor the window.
 *   - Reading the window never opens one. An elapsed window reads as inactive
 *     with a zero total, but the reset is only committed by the next spend.
 *
 * Every endpoint accepts an optional `now` (epoch ms) so window elapse is
 * deterministic in tests; it defaults to `Date.now()`.
 */

const LIMIT = 1000;
const WINDOW_MS = 60_000;

/** accountId -> { windowStartedAt, spent, spends } */
const windows = new Map();

/** Clears all tracked accounts. Exported for tests. */
export function resetState() {
  windows.clear();
}

function resolveNow(now) {
  if (now === undefined || now === null) return { now: Date.now() };
  if (typeof now !== "number" || !Number.isFinite(now)) return { error: "invalid_now" };
  return { now };
}

function isElapsed(entry, now) {
  return now - entry.windowStartedAt >= WINDOW_MS;
}

/**
 * The account's window as of `now`, without committing anything. Returns the
 * live window, or `null` when the account has never spent or its window has
 * already elapsed.
 */
function activeWindow(accountId, now) {
  const entry = windows.get(accountId);
  if (!entry) return null;
  if (isElapsed(entry, now)) return null;
  return entry;
}

function windowView(accountId, entry, now) {
  if (!entry) {
    return {
      account: accountId,
      active: false,
      limit: LIMIT,
      windowMs: WINDOW_MS,
      spent: 0,
      remaining: LIMIT,
      spendCount: 0,
      windowStartedAt: null,
      windowEndsAt: null,
      msRemaining: 0,
    };
  }

  const windowEndsAt = entry.windowStartedAt + WINDOW_MS;
  return {
    account: accountId,
    active: true,
    limit: LIMIT,
    windowMs: WINDOW_MS,
    spent: entry.spent,
    remaining: LIMIT - entry.spent,
    spendCount: entry.spends.length,
    windowStartedAt: entry.windowStartedAt,
    windowEndsAt,
    msRemaining: windowEndsAt - now,
  };
}

/**
 * `POST /spend` — record a spend against the account's window.
 *
 * Opens a window if none is live, which covers both the first-ever spend and
 * the first spend after an elapsed window. `windowReset` reports which of those
 * happened so a caller can see the reset without diffing timestamps.
 */
export function recordSpend({ account, amount, now } = {}) {
  if (typeof account !== "string" || account.trim().length === 0) {
    return { status: 400, payload: { error: "account_required" } };
  }
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return { status: 400, payload: { error: "invalid_amount" } };
  }

  const clock = resolveNow(now);
  if (clock.error) return { status: 400, payload: { error: clock.error } };
  const at = clock.now;

  const existing = windows.get(account);
  // Time must not run backwards within a live window, or the elapse check and
  // `msRemaining` stop meaning anything.
  if (existing && !isElapsed(existing, at) && at < existing.windowStartedAt) {
    return {
      status: 400,
      payload: { error: "now_before_window_start", windowStartedAt: existing.windowStartedAt },
    };
  }

  const live = activeWindow(account, at);
  const windowReset = existing !== undefined && live === null;

  const entry = live ?? { windowStartedAt: at, spent: 0, spends: [] };

  if (entry.spent + amount > LIMIT) {
    // Rejected: nothing is recorded, and an elapsed window stays uncommitted so
    // a later spend still sees the same reset.
    return {
      status: 429,
      payload: {
        error: "limit_exceeded",
        ...windowView(account, live, at),
        attempted: amount,
        wouldBeSpent: entry.spent + amount,
      },
    };
  }

  entry.spent += amount;
  entry.spends.push({ amount, at });
  windows.set(account, entry);

  return {
    status: 200,
    payload: { ...windowView(account, entry, at), accepted: amount, windowReset },
  };
}

/**
 * `GET /window?account=<id>&now=<ms>` — read the window without touching it.
 * An elapsed window reads as inactive; only a spend commits the reset.
 */
export function getWindow({ account, now } = {}) {
  if (typeof account !== "string" || account.trim().length === 0) {
    return { status: 400, payload: { error: "account_required" } };
  }

  const clock = resolveNow(now);
  if (clock.error) return { status: 400, payload: { error: clock.error } };
  const at = clock.now;

  const entry = windows.get(account);
  const live = activeWindow(account, at);
  return {
    status: 200,
    payload: {
      ...windowView(account, live, at),
      elapsed: entry !== undefined && live === null,
    },
  };
}

/** `POST /reset` — drop an account's window outright. */
export function resetAccount({ account } = {}) {
  if (typeof account !== "string" || account.trim().length === 0) {
    return { status: 400, payload: { error: "account_required" } };
  }
  const existed = windows.delete(account);
  return { status: 200, payload: { account, cleared: existed } };
}

function numberOrUndefined(raw) {
  if (raw === null || raw === undefined) return undefined;
  return Number(raw);
}

export function handleRequest(method, pathname, body, query) {
  if (method === "POST" && pathname === "/spend") return recordSpend(body ?? {});
  if (method === "POST" && pathname === "/reset") return resetAccount(body ?? {});
  if (method === "GET" && pathname === "/window") {
    return getWindow({ account: query?.account, now: numberOrUndefined(query?.now) });
  }
  return { status: 404, payload: { error: "not_found" } };
}

const PORT = process.env.PORT || 4098;
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
    console.log(`spending-window-suite mock listening on http://localhost:${PORT}/window`);
  });
}
