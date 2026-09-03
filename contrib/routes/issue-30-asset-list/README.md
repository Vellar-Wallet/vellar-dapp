# Mock route: paginated asset list (Issue #30)

Standalone mock GET route returning a paginated list of sample asset
entries. No real chain or database access.

## Run

```sh
node route.mjs
# asset-list mock listening on http://localhost:4030/assets?page=&pageSize=
```

## Test

```sh
node route.test.mjs
```

## Example

Request:

```
GET /assets?page=2&pageSize=5
```

Response:

```json
{
  "items": [
    {
      "code": "SHX",
      "issuer": "GDSTRSHXHGJ7ZIVRBXEYE5Q74XUVCUSEKEBR7UCHEUUJK6PPZOD4KEUY",
      "balance": "12000.0000000"
    },
    {
      "code": "USDT",
      "issuer": "GCQTGZQQ5G4PTM2GL7CDIFKUBIPEC52BROAQIAPW53XBRJVN6ZJVTG6V",
      "balance": "999.9900000"
    },
    {
      "code": "MOBI",
      "issuer": "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
      "balance": "42.0000000"
    },
    {
      "code": "RIO",
      "issuer": "GCFVEHW5VXTQCLXIN2CGKGMKZOUQOMOQ5PL22F5C6HG5CY73GYYZ6RIO",
      "balance": "1500.0000000"
    },
    {
      "code": "SLT",
      "issuer": "GCKA6K5PCQ6PNF5RQBF7PQDJWRHOKUJT5IWEG7NRZDGCQNK7PGYQHYCE",
      "balance": "300.7500000"
    }
  ],
  "total": 12,
  "page": 2,
  "pageSize": 5
}
```

`page` defaults to `1` and `pageSize` defaults to `10`. Invalid or missing
values fall back to their defaults instead of erroring.
