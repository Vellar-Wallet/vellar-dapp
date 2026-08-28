# Mock route: notification preference management (Issue #139)

Standalone mock route module for getting and updating a sample set of
notification preferences per account. State is kept in-memory and resets
whenever the process restarts. No real chain or database access.

## Run

```sh
node route.mjs
# notification-prefs mock listening on http://localhost:4139/notification-prefs/:accountId
```

## Test

```sh
node route.test.mjs
```

## Endpoints

### `GET /notification-prefs/:accountId`

Returns the account's notification preferences. An account that has never
been explicitly configured gets the default set:

```json
{
  "accountId": "acct_new",
  "preferences": { "email": true, "push": true, "sms": false, "marketing": false }
}
```

### `PATCH /notification-prefs/:accountId`

Updates one or more preference fields. Only the fields provided in the
request body are changed; all other fields (including any from earlier
updates) are left as-is.

Request:

```json
{ "sms": true }
```

Response (`200`):

```json
{
  "accountId": "acct_new",
  "preferences": { "email": true, "push": true, "sms": true, "marketing": false }
}
```

An unrecognized field name returns `400 invalid_field`; a missing account id
returns `400 account_id_required`.

`route.test.mjs` covers the default-preferences case and a partial update
that changes one field while confirming the rest are preserved across
repeated updates.
