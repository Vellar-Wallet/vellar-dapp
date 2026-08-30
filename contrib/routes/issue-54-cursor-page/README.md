# Mock route: cursor page (Issue #54)

Standalone mock GET route returning a page of sample items together with a
cursor pointing at the next page. No real chain or database access.

The sample set holds 10 items and the page size is 4, so the data pages as
4 + 4 + 2.

## Run

```sh
node route.mjs
# cursor-page mock listening on http://localhost:4054/cursor-page
```

## Test

```sh
node route.test.mjs
```

## Query parameters

| Parameter | Required | Meaning                                                          |
| --------- | -------- | ---------------------------------------------------------------- |
| `cursor`  | no       | Opaque marker from a previous response. Omit for the first page. |

## Response

| Field        | Type           | Meaning                                                 |
| ------------ | -------------- | ------------------------------------------------------- |
| `items`      | array          | The items on this page.                                 |
| `nextCursor` | string or null | Cursor for the following page, `null` on the last page. |

`nextCursor` is always present, so callers can loop on
`while (nextCursor !== null)` without checking for a missing key.

## Example

First page:

```
GET /cursor-page
```

```json
{
  "items": [
    { "id": "itm_01", "label": "Coffee subscription" },
    { "id": "itm_02", "label": "Domain renewal" },
    { "id": "itm_03", "label": "Cloud storage" },
    { "id": "itm_04", "label": "Team lunch" }
  ],
  "nextCursor": "b2Zmc2V0OjQ"
}
```

Last page:

```
GET /cursor-page?cursor=b2Zmc2V0Ojg
```

```json
{
  "items": [
    { "id": "itm_09", "label": "Payment processor fee" },
    { "id": "itm_10", "label": "Hardware wallet" }
  ],
  "nextCursor": null
}
```

## About the cursor

Treat the cursor as opaque. It happens to be a base64url encoding of
`offset:<n>`, but that is an implementation detail: do not parse it, do not do
arithmetic on it, and do not construct one by hand.

The route enforces that. A cursor it did not issue -- malformed, or an offset
that is out of range or off a page boundary -- gets `400 invalid_cursor` rather
than silently restarting at the first page, which would otherwise show up as a
pagination loop in the caller. An omitted or empty `cursor` is not an error; it
simply means "first page".
