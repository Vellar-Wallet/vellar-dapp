# Mock route / validator: allowed assets configuration (Issue #73)

Standalone mock route module under `contrib/routes/` validating the `allowedAssets` array configuration structure.

## Asset Types

Supported asset types:
- `native` (XLM)
- `credit_alphanum4` (e.g. USDC)
- `credit_alphanum12` (e.g. STELLARLUMEN)

## Run

```sh
node route.mjs
```

## Example

```
POST /allowed-assets
{
  "allowedAssets": [
    { "code": "XLM", "type": "native" },
    { "code": "USDC", "type": "credit_alphanum4", "issuer": "GA5ZSE..." }
  ]
}
```
