import http from "node:http";
import crypto from "node:crypto";

/**
 * Mock Route Module: Support Ticket (Issue #143)
 * Create endpoint returns a ticketId starting in an "open" state.
 * Status endpoint returns a 404 style payload for an unknown ticketId.
 */

const tickets = new Map();

export function createTicket({ subject, message } = {}) {
  if (typeof subject !== "string" || subject.trim().length === 0) {
    return { status: 400, payload: { error: "subject_required" } };
  }

  const ticketId = crypto.randomUUID();
  const ticket = {
    ticketId,
    subject,
    message: typeof message === "string" ? message : "",
    status: "open",
    createdAt: new Date().toISOString(),
  };
  tickets.set(ticketId, ticket);

  return { status: 201, payload: ticket };
}

export function getTicketStatus(ticketId) {
  const ticket = tickets.get(ticketId);
  if (!ticket) {
    return { status: 404, payload: { error: "ticket_not_found", ticketId } };
  }

  return { status: 200, payload: { ticketId: ticket.ticketId, status: ticket.status } };
}

export function handleRequest(req, res, bodyData) {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "POST" && parts[0] === "tickets" && parts.length === 1) {
    let parsed;
    try {
      parsed = JSON.parse(bodyData || "{}");
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_json" }));
      return;
    }

    const { status, payload } = createTicket(parsed);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }

  if (req.method === "GET" && parts[0] === "tickets" && parts.length === 2) {
    const { status, payload } = getTicketStatus(parts[1]);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

const PORT = process.env.PORT || 4143;
if (process.argv[1] && process.argv[1].endsWith("route.mjs")) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      handleRequest(req, res, body);
    });
  });

  server.listen(PORT, () => {
    console.log(`support-ticket mock listening on http://localhost:${PORT}/tickets`);
  });
}
