import assert from "node:assert/strict";
import { handleRequest, resetState } from "./route.mjs";

function createTicket(subject, now) {
  return handleRequest({ method: "POST", path: "/tickets", body: { subject, now } });
}

function checkEscalation(ticketId, now) {
  return handleRequest({
    method: "GET",
    path: `/tickets/${ticketId}/check-escalation`,
    query: { now },
  });
}

function resolveTicket(ticketId) {
  return handleRequest({ method: "POST", path: `/tickets/${ticketId}/resolve` });
}

resetState();

// Creating a ticket starts it at "low" priority.
const created = createTicket("Payment stuck", "2026-01-01T00:00:00.000Z");
assert.equal(created.status, 201);
assert.equal(created.body.priority, "low");
assert.equal(created.body.resolved, false);
const ticketId = created.body.id;

// A ticket checked well before the 24h threshold has not escalated.
const notYetEscalated = checkEscalation(ticketId, "2026-01-01T10:00:00.000Z");
assert.equal(notYetEscalated.status, 200);
assert.equal(notYetEscalated.body.priority, "low");
assert.equal(notYetEscalated.body.escalated, false);

// A ticket checked past two threshold periods (48h+) has escalated two
// levels, to "high".
const pastThreshold = checkEscalation(ticketId, "2026-01-03T01:00:00.000Z");
assert.equal(pastThreshold.status, 200);
assert.equal(pastThreshold.body.priority, "high");
assert.equal(pastThreshold.body.escalated, true);

// Escalation caps at "urgent" and does not go further.
const farPastThreshold = checkEscalation(ticketId, "2026-02-01T00:00:00.000Z");
assert.equal(farPastThreshold.body.priority, "urgent");

// Resolving a ticket stops further escalation.
const resolved = resolveTicket(ticketId);
assert.equal(resolved.status, 200);
assert.equal(resolved.body.resolved, true);

const afterResolve = checkEscalation(ticketId, "2026-03-01T00:00:00.000Z");
assert.equal(afterResolve.body.resolved, true);
assert.equal(afterResolve.body.escalated, false);
assert.equal(afterResolve.body.priority, "urgent");

// Unknown ticket returns 404.
assert.equal(checkEscalation("ticket_9999", "2026-01-01T00:00:00.000Z").status, 404);

// Validation errors.
assert.equal(createTicket("", "2026-01-01T00:00:00.000Z").status, 400);
assert.equal(createTicket("Subject", null).status, 400);
assert.equal(createTicket("Subject", "not-a-date").status, 400);
assert.equal(handleRequest({ method: "GET", path: `/tickets/${ticketId}/check-escalation`, query: {} }).status, 400);

// Routing and method guards.
assert.equal(handleRequest({ method: "GET", path: "/tickets" }).status, 405);
assert.equal(handleRequest({ method: "GET", path: "/unknown" }).status, 404);

console.log("PASS: ticket-escalation-suite escalates priority past the simulated threshold and caps at urgent");
