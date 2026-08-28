# Mock route module: support ticket (Issue #143)

Self contained route module with endpoints to create a support ticket and to
check its status by id.

## Endpoints

- `POST /tickets`
  - Body: `{ "subject": string, "message"?: string }`
  - Creates a ticket in the `open` state and returns it, including `ticketId`.
  - Missing `subject` responds `400` with `{ error: "subject_required" }`.
- `GET /tickets/:ticketId`
  - Returns `{ ticketId, status }` for a known ticket.
  - Unknown `ticketId` responds `404` with `{ error: "ticket_not_found", ticketId }`.

## Run

```sh
node route.mjs
```

## Testing

Covers create then status lookup, and an unknown ticketId:

```sh
node route.test.mjs
```
