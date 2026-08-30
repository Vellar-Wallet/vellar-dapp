# Mock route: remove recipient nickname (Issue #133)

Standalone mock route module accepting a `DELETE` request for a recipient
nickname and returning a removal confirmation. In-memory sample dataset
only, no chain or database access. State resets whenever the process
restarts.

## Run

```sh
node route.mjs
# remove-nickname mock listening on http://localhost:4133/nicknames/{nickname}
```

## Test

```sh
node route.test.mjs
```

## Endpoints

### `DELETE /nicknames/:nickname`

Response on a hit (`200`):

```json
{ "removed": true, "nickname": "Mum" }
```

Response when the nickname is not in the sample dataset (`404`):

```json
{ "error": "not_found", "message": "nickname Unknown does not exist" }
```

Sample dataset seeds `Mum`, `Landlord`, and `Savings Pool`. Once removed, a
nickname stays removed for the lifetime of the process (call `resetState()`
in a test to restore the seed set).
