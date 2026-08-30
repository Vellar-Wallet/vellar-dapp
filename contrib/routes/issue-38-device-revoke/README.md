# Mock route: device session revoke (Issue #38)

Standalone mock DELETE route that revokes a device session by id and echoes the
revoked id back.

This is a **mock**. No session store, chain or database is touched. The sample
dataset is read-only, so nothing is actually invalidated and revoking the same id
twice returns the same success payload both times.

## Run

```sh
node route.mjs
# device-revoke mock listening on http://localhost:4038/device-sessions/:id
```

## Test

```sh
node route.test.mjs
```

## Request

```
DELETE /device-sessions/<id>
```

## Example — found

Request:

```
DELETE /device-sessions/ses_a1b2c3
```

Response `200`:

```json
{
  "revoked": true,
  "id": "ses_a1b2c3",
  "device": "iPhone 15 Pro",
  "platform": "ios",
  "revokedAt": "2026-07-28T12:00:00.000Z"
}
```

## Example — not found

Request:

```
DELETE /device-sessions/ses_missing
```

Response `404`:

```json
{
  "error": "not_found",
  "message": "No device session found for id \"ses_missing\""
}
```

A missing or empty id is treated the same way as an unknown one.

## Sample data

| Session id   | Device           | Platform    |
| ------------ | ---------------- | ----------- |
| `ses_a1b2c3` | iPhone 15 Pro    | `ios`       |
| `ses_d4e5f6` | Pixel 8          | `android`   |
| `ses_g7h8i9` | MacBook Pro      | `web`       |
| `ses_j1k2l3` | Chrome Extension | `extension` |
