import assert from "node:assert/strict";
import { createTicket, getTicketStatus } from "./route.mjs";

// Create: success case returns an open ticket.
let { status, payload } = createTicket({ subject: "Cannot connect wallet", message: "Help!" });
assert.equal(status, 201);
assert.equal(payload.status, "open");
assert.equal(typeof payload.ticketId, "string");
assert.ok(payload.ticketId.length > 0);

// Create: missing subject is rejected.
const missingSubject = createTicket({ message: "no subject here" });
assert.equal(missingSubject.status, 400);
assert.equal(missingSubject.payload.error, "subject_required");

// Status: lookup of a freshly created ticket returns "open".
const statusLookup = getTicketStatus(payload.ticketId);
assert.equal(statusLookup.status, 200);
assert.equal(statusLookup.payload.ticketId, payload.ticketId);
assert.equal(statusLookup.payload.status, "open");

// Status: unknown ticketId returns a 404 style payload.
const unknown = getTicketStatus("does-not-exist");
assert.equal(unknown.status, 404);
assert.equal(unknown.payload.error, "ticket_not_found");

console.log("PASS: /tickets create then status lookup, including an unknown ticketId");
