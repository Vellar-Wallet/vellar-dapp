# Mock route: account cleanup plan (Issue #47)

Standalone mock GET route returning a fixed sample account cleanup plan — the
set of things standing between an account and a merge.

The payload carries a `blockers` array (each entry has a `type` and a
`description`) and a `mergeReady` boolean. `mergeReady` is always derived from
the blockers list inside `buildPlan`, never stored next to it, so the flag
cannot drift out of sync with the data it summarizes.

No chain or database access — the plan is a hard-coded fixture.

## Run

```sh
node route.mjs
# cleanup-plan mock listening on http://localhost:4047/cleanup-plan
```

## Test

```sh
node route.test.mjs
```

The test checks the response shape and asserts the `mergeReady` logic in both
directions: false for the sample plan and for a plan with a single blocker,
true only when `blockers` is empty.

## Blocker types

`trustline`, `offer`, `data_entry`, `signer`, `balance`.

## Example

Request:

```
GET /cleanup-plan
```

Response:

```json
{
  "accountId": "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
  "generatedAt": "2026-07-20T09:00:00.000Z",
  "blockers": [
    {
      "type": "trustline",
      "description": "Trustline to USDC must be removed before the account can be merged."
    },
    {
      "type": "offer",
      "description": "One open offer (XLM for EURC) is still on the order book."
    },
    {
      "type": "data_entry",
      "description": "Managed data entry \"vellar:device\" must be deleted."
    }
  ],
  "mergeReady": false
}
```

Any other method or path returns `404` with `{ "error": "not_found" }`.
