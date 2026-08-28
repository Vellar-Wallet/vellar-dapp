# Mock route: withdrawal approval flow (Issue #144)

A self contained route module that takes a withdrawal request and reports
whether it needs a human to sign off, based on a configured amount threshold.

Everything lives in memory in `route.mjs`. No funds move, no account is touched,
and no network call is made.

## The rule

A withdrawal **at** the threshold is still automatic. Only an amount **strictly
above** it needs manual approval.

| Amount        | `requiresApproval` | `status`           |
| ------------- | ------------------ | ------------------ |
| `499.9999999` | `false`            | `auto_approved`    |
| `500.0000000` | `false`            | `auto_approved`    |
| `500.0000001` | `true`             | `pending_approval` |

The decision is made once, at request time, and stored on the record. Reading a
request back never re-evaluates it — a request already in flight keeps the rule
it was admitted under, which is why `threshold` is echoed on every response.

## Amounts are compared in stroops

Amounts are Stellar-style decimal strings with up to 7 decimal places, parsed to
integer stroops (`1 stroop = 0.0000001`) and compared as `BigInt`.

This is not decoration. The threshold is a yes/no decision about money, and
float comparison is exactly the kind of rounding that should never be what
decides whether a withdrawal gets seen by a person. It also means an amount well
past `Number.MAX_SAFE_INTEGER` still compares exactly.

Anything that is not a positive amount with at most 7 decimal places is a `400`
— including `""`, `"-5"`, `"0"`, `"1e3"`, `NaN` and `Infinity`, all of which
`Number()` would otherwise wave through. A missing amount is refused rather than
read as zero and quietly auto-approved.

## Endpoints

### `GET /policy`

The threshold currently in effect, readable without submitting anything.

```json
{
  "asset": "XLM",
  "threshold": "500.0000000",
  "rule": "amount > threshold requires manual approval; amount == threshold does not"
}
```

### `POST /request`

Submits a withdrawal and returns the approval decision with it.

Request:

```json
{ "account": "GA_ALICE", "amount": "500.0000001", "reference": "payroll" }
```

Response — `201`:

```json
{
  "id": "0f0a2f5e-...",
  "account": "GA_ALICE",
  "amount": "500.0000001",
  "asset": "XLM",
  "reference": "payroll",
  "requiresApproval": true,
  "status": "pending_approval",
  "threshold": "500.0000000",
  "requestedAt": "2026-08-27T10:15:00.000Z"
}
```

`reference` is optional and defaults to `null`. A rejected request is not
stored, so its id never becomes readable.

Response — `400`:

```json
{
  "error": "invalid_request",
  "field": "amount",
  "reason": "must be a positive decimal with at most 7 decimal places",
  "received": "-1"
}
```

### `GET /status?id=<requestId>`

Whether a stored withdrawal needs manual approval.

```json
{
  "id": "0f0a2f5e-...",
  "account": "GA_ALICE",
  "amount": "500.0000001",
  "requiresApproval": true,
  "status": "pending_approval",
  "threshold": "500.0000000"
}
```

An unknown id responds `404` with `request_not_found`; a missing or empty id is
a `400`. Responses are copies, so mutating one cannot rewrite the stored
decision.

## Run

```sh
node route.mjs
# withdrawal-approval mock listening on http://localhost:4144/policy
```

Override the port with `PORT=5000 node route.mjs`.

```sh
curl localhost:4144/policy

curl -X POST localhost:4144/request \
  -H 'content-type: application/json' \
  -d '{"account":"GA_ALICE","amount":"500.0000001"}'

curl 'localhost:4144/status?id=<requestId>'
```

## Test

```sh
node route.test.mjs
```

The tests cover the threshold boundary in both directions, every rejected amount
shape, an amount beyond `Number.MAX_SAFE_INTEGER`, unknown and malformed ids,
and that a mutated response cannot rewrite stored state.
