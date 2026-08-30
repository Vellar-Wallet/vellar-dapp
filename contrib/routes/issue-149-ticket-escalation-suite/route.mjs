// Mock route suite simulating a support ticket escalation workflow: a
// ticket climbs priority levels the longer it stays unresolved past a
// simulated time threshold. In-memory only, no chain, RPC, or database
// access. State resets whenever the process restarts.
import http from "node:http";
import { URL } from "node:url";

const PRIORITY_LEVELS = ["low", "medium", "high", "urgent"];
// Escalate one level for every full threshold period the ticket has been
// open, as measured from its createdAt to the simulated "now".
const ESCALATION_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 simulated hours

let tickets = new Map();
let nextId = 1;

export function resetState() {
  tickets = new Map();
  nextId = 1;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function escalatedLevel(createdAt, simulatedNow) {
  const elapsedMs = simulatedNow.getTime() - new Date(createdAt).getTime();
  if (elapsedMs < 0) return 0;
  const stepsElapsed = Math.floor(elapsedMs / ESCALATION_THRESHOLD_MS);
  return Math.min(stepsElapsed, PRIORITY_LEVELS.length - 1);
}

// POST /tickets — create a new ticket at "low" priority, timestamped with
// the given simulated current time.
export function createTicket({ body = {} } = {}) {
  const { subject, now } = body;

  if (!isNonEmptyString(subject)) {
    return {
      status: 400,
      body: { error: "invalid_subject", message: "subject is required and must be a non-empty string" },
    };
  }
  if (!now) {
    return { status: 400, body: { error: "missing_now", message: "now is required" } };
  }
  const createdAt = new Date(now);
  if (!isValidDate(createdAt)) {
    return { status: 400, body: { error: "invalid_now", message: "now must be a valid ISO date" } };
  }

  const ticket = {
    id: `ticket_${String(nextId).padStart(4, "0")}`,
    subject,
    createdAt: createdAt.toISOString(),
    resolved: false,
    priority: PRIORITY_LEVELS[0],
  };
  nextId += 1;
  tickets.set(ticket.id, ticket);

  return { status: 201, body: ticket };
}

// GET /tickets/:id/check-escalation?now=... — recompute and persist the
// ticket's priority based on how long it has been open as of the
// simulated "now".
export function checkEscalation({ ticketId, query = {} } = {}) {
  if (!isNonEmptyString(ticketId)) {
    return { status: 400, body: { error: "invalid_ticket_id", message: "ticketId is required" } };
  }

  const ticket = tickets.get(ticketId);
  if (!ticket) {
    return { status: 404, body: { error: "not_found", message: `ticket ${ticketId} was not found` } };
  }

  const { now } = query;
  if (!now) {
    return { status: 400, body: { error: "missing_now", message: "now query parameter is required" } };
  }
  const simulatedNow = new Date(now);
  if (!isValidDate(simulatedNow)) {
    return { status: 400, body: { error: "invalid_now", message: "now must be a valid ISO date" } };
  }

  if (ticket.resolved) {
    return {
      status: 200,
      body: { id: ticket.id, priority: ticket.priority, resolved: true, escalated: false },
    };
  }

  const levelIndex = escalatedLevel(ticket.createdAt, simulatedNow);
  const previousPriority = ticket.priority;
  ticket.priority = PRIORITY_LEVELS[levelIndex];

  return {
    status: 200,
    body: {
      id: ticket.id,
      priority: ticket.priority,
      resolved: false,
      escalated: ticket.priority !== previousPriority,
    },
  };
}

// POST /tickets/:id/resolve — marks a ticket resolved so it stops
// escalating.
export function resolveTicket({ ticketId } = {}) {
  const ticket = tickets.get(ticketId);
  if (!ticket) {
    return { status: 404, body: { error: "not_found", message: `ticket ${ticketId} was not found` } };
  }
  ticket.resolved = true;
  return { status: 200, body: { id: ticket.id, resolved: true } };
}

export function handleRequest({ method = "GET", path = "", query = {}, body = {} } = {}) {
  if (path === "/tickets") {
    return method === "POST"
      ? createTicket({ body })
      : { status: 405, body: { error: "method_not_allowed" } };
  }

  const escalationMatch = path.match(/^\/tickets\/([^/]+)\/check-escalation$/);
  if (escalationMatch) {
    return method === "GET"
      ? checkEscalation({ ticketId: escalationMatch[1], query })
      : { status: 405, body: { error: "method_not_allowed" } };
  }

  const resolveMatch = path.match(/^\/tickets\/([^/]+)\/resolve$/);
  if (resolveMatch) {
    return method === "POST"
      ? resolveTicket({ ticketId: resolveMatch[1] })
      : { status: 405, body: { error: "method_not_allowed" } };
  }

  return { status: 404, body: { error: "not_found" } };
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
  });
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const query = Object.fromEntries(url.searchParams.entries());
    const body = await readJsonBody(req);
    const result =
      body === null
        ? { status: 400, body: { error: "invalid_json" } }
        : handleRequest({ method: req.method, path: url.pathname, query, body });
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  const port = process.env.PORT || 4149;
  server.listen(port, () => {
    console.log(`ticket-escalation-suite listening on http://localhost:${port}`);
    console.log(`  POST /tickets                              body: { subject, now }`);
    console.log(`  GET  /tickets/:id/check-escalation?now=...`);
    console.log(`  POST /tickets/:id/resolve`);
  });
}
