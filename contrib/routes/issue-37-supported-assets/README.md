# Mock route: supported assets (Issue #37)

Standalone mock GET route returning a fixed list of supported asset codes and
their display names, with an optional prefix search.

This is a **mock**. The list is hard-coded in `route.mjs` — it is not fetched from
Horizon, a token registry, or any database.

## Run

```sh
node route.mjs
# supported-assets mock listening on http://localhost:4037/supported-assets?search=
```

## Test

```sh
node route.test.mjs
```

## Request

```
GET /supported-assets?search=<prefix>
```

| Query    | Required | Notes                                                    |
| -------- | -------- | -------------------------------------------------------- |
| `search` | no       | Case-insensitive prefix match against the asset **code** |

`search` matches code prefixes only — it does not match display names, and it does
not match substrings (`XLM` matches `XLM` but not `yXLM`). An empty or
whitespace-only `search` returns the full list.

## Example

Request:

```
GET /supported-assets?search=us
```

Response `200`:

```json
{
  "items": [
    { "code": "USDC", "name": "USD Coin" },
    { "code": "USDT", "name": "Tether USD" }
  ],
  "total": 2,
  "search": "us"
}
```

An unmatched prefix returns an empty list rather than an error:

```json
{ "items": [], "total": 0, "search": "zzz" }
```

## Sample data

| Code   | Display name         |
| ------ | -------------------- |
| `XLM`  | Stellar Lumens       |
| `USDC` | USD Coin             |
| `USDT` | Tether USD           |
| `EURC` | Euro Coin            |
| `AQUA` | Aquarius             |
| `yXLM` | Yield XLM            |
| `BTC`  | Bitcoin              |
| `ETH`  | Ethereum             |
| `SHX`  | Stronghold Token     |
| `NGNT` | Nigerian Naira Token |
