# Mock route suite: webhook subscription CRUD (Issue #137)

Standalone mock route suite with endpoints to create, list, and delete
webhook subscriptions. Subscriptions are held in memory for the lifetime
of the process — no chain, RPC, or database access.

## Run

```sh
node route.mjs
# webhook-crud suite listening on http://localhost:4137
```

## Test

```sh
node route.test.mjs
```

## Endpoints

### `POST /webhook-subscriptions`

Creates a webhook subscription. Requires a `url` string and a non-empty
`events` array.

Body:

```json
{ "url": "https://example.com/hooks/a", "events": ["payment.settled"] }
```

Response (`201`):

```json
{
  "id": "sub_0001",
  "url": "https://example.com/hooks/a",
  "events": ["payment.settled"],
  "createdAt": "2026-08-25T00:00:00.000Z"
}
```

Errors: `400` with `{ "error": "url_required" }` or
`{ "error": "events_required" }`.

### `GET /webhook-subscriptions`

Lists all subscriptions created so far.

```json
{ "subscriptions": [ { "id": "sub_0001", "url": "...", "events": [...], "createdAt": "..." } ] }
```

### `DELETE /webhook-subscriptions/:id`

Deletes a subscription by id.

Response on success (`200`):

```json
{ "deleted": true, "id": "sub_0001" }
```

Response for an unknown id (`404`):

```json
{ "error": "not_found", "message": "No webhook subscription found for id \"sub_9999\"" }
```

Any other path returns `404` with `{ "error": "not_found" }`; a wrong
method on a known path returns `405` with `{ "error": "method_not_allowed" }`.

## Notes

`resetState()` is exported so a test can clear the in-memory subscription
list.
