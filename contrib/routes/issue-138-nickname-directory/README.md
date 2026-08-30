# Mock route: recipient nickname directory (Issue #138)

Standalone mock route module maintaining a directory of nickname to address
mappings, with add, lookup, and remove endpoints. State is kept in-memory
(seeded with one sample entry) and resets whenever the process restarts. No
real chain or database access.

## Run

```sh
node route.mjs
# nickname-directory mock listening on http://localhost:4138/nicknames
```

## Test

```sh
node route.test.mjs
```

## Endpoints

### `POST /nicknames`

Adds a nickname -> address mapping.

Request:

```json
{ "nickname": "bob", "address": "GB222..." }
```

Response (`200`):

```json
{ "added": true, "nickname": "bob", "address": "GB222..." }
```

A missing `nickname` returns `400 nickname_required`; a missing `address`
returns `400 address_required`. Adding a nickname that already exists
returns `409 nickname_exists`.

### `GET /nicknames/:nickname`

Looks up the address for a nickname.

Response when found (`200`):

```json
{ "nickname": "bob", "address": "GB222..." }
```

Response for an unknown nickname (`404`):

```json
{ "error": "nickname_not_found", "message": "No entry found for nickname \"bob\"" }
```

### `DELETE /nicknames/:nickname`

Removes a nickname mapping. Returns `200 { removed: true, nickname }` on
success, or the same `404 nickname_not_found` payload as lookup if the
nickname doesn't exist.

`route.test.mjs` covers add, lookup, a duplicate add rejection, remove, and
lookup-after-remove.
