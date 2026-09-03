# Mock route: recipient allowlist/denylist (Issue #75)

Standalone mock route module for maintaining an allowlist and denylist of
recipient addresses. State is kept in-memory (seeded with one sample allowed
and one sample denied recipient) and resets whenever the process restarts.
No real chain or database access.

## Run

```sh
node route.mjs
# recipient-lists mock listening on http://localhost:4075/recipient-lists/{add,check}
```

## Test

```sh
node route.test.mjs
```

## Endpoints

### `POST /recipient-lists/add`

Adds a recipient to the allow or deny list.

Request:

```json
{ "type": "deny", "recipient": "GC333..." }
```

Response:

```json
{ "added": true, "type": "deny", "recipient": "GC333..." }
```

`type` must be `"allow"` or `"deny"`; anything else returns `400
invalid_list_type`. A missing `recipient` returns `400 recipient_required`.

### `GET /recipient-lists/check?recipient=...`

Returns which list (if any) contains the given recipient.

Response when found:

```json
{ "recipient": "GA111...", "list": "allow" }
```

Response when not on either list:

```json
{ "recipient": "GC333...", "list": null }
```
