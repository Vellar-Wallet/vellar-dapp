# Mock route: sample webhook subscription list (Issue #134)

Standalone mock GET route that returns a fixed array of sample webhook
subscription records. No chain, RPC, or database access — the list is a
static in-memory sample.

## Run

```sh
node route.mjs
# webhook-list mock listening on http://localhost:4134/webhook-subscriptions
```

## Test

```sh
node route.test.mjs
```

## Example

Request:

```
GET /webhook-subscriptions
```

Response:

```json
{
  "subscriptions": [
    {
      "url": "https://example.com/hooks/payments",
      "events": ["payment.settled", "payment.failed"]
    },
    {
      "url": "https://example.com/hooks/accounts",
      "events": ["account.created", "account.closed"]
    },
    { "url": "https://example.com/hooks/policies", "events": ["policy.updated"] }
  ]
}
```

A wrong method returns `405` with `{ "error": "method_not_allowed" }`; any
other path returns `404` with `{ "error": "not_found" }`.
