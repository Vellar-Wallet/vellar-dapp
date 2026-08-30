# Mock route: activity log with cursor pagination (Issue #59)

Standalone mock GET route returning a cursor-paginated list of sample
activity log entries. No real chain or database access -- 18 entries are
hardcoded in-module, newest first.

## Run

```sh
node route.mjs
# activity-log-cursor mock listening on http://localhost:4059/activity-log?cursor=&limit=
```

## Test

```sh
node route.test.mjs
```

## Endpoint

### `GET /activity-log?cursor=&limit=`

- `cursor` -- the `id` of the last entry already seen; omit for the first
  page. An unrecognized/stale cursor restarts pagination from the
  beginning rather than erroring.
- `limit` -- page size, default `5`, clamped to a max of `50`. Invalid
  values (non-integer, `< 1`) fall back to the default.

Response (`200`):

```json
{
  "items": [
    { "id": "act_018", "type": "payment_sent", "summary": "Sent 25 XLM to GABCD...FGH", "timestamp": "2026-07-28T09:45:00.000Z" },
    { "id": "act_017", "type": "policy_updated", "summary": "Updated spending-limit policy pol_1001", "timestamp": "2026-07-28T09:30:00.000Z" },
    { "id": "act_016", "type": "payment_received", "summary": "Received 100 USDC from GXYZ9...WVU", "timestamp": "2026-07-28T09:10:00.000Z" },
    { "id": "act_015", "type": "session_started", "summary": "New session started from Chrome/macOS", "timestamp": "2026-07-28T08:55:00.000Z" },
    { "id": "act_014", "type": "trustline_added", "summary": "Added trustline for AQUA", "timestamp": "2026-07-27T22:40:00.000Z" }
  ],
  "nextCursor": "act_014"
}
```

The last page (nothing left to fetch) has `"nextCursor": null`:

```
GET /activity-log?cursor=act_002&limit=5
```

```json
{
  "items": [
    { "id": "act_001", "type": "wallet_created", "summary": "Wallet created", "timestamp": "2026-07-23T10:00:00.000Z" }
  ],
  "nextCursor": null
}
```

## Walking every page

```js
let cursor;
const all = [];
do {
  const res = await fetch(`http://localhost:4059/activity-log?limit=5${cursor ? `&cursor=${cursor}` : ""}`);
  const { items, nextCursor } = await res.json();
  all.push(...items);
  cursor = nextCursor;
} while (cursor);
```

`route.test.mjs` exercises exactly this loop against `handleRequest`
directly and asserts all 18 entries are visited exactly once with no
gaps or duplicates.
