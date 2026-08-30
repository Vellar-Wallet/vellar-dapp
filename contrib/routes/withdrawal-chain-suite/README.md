# Route suite: withdrawal approval chain with limits (Issue #148)

Self contained route handlers that route a withdrawal through **zero, one, or
two** levels of approval depending on how large it is.

Everything is in memory in `route.mjs`. No funds move, no account is touched,
and no network call is made.

## The chain

| Amount                        | Tier       | Levels | What happens              |
| ----------------------------- | ---------- | ------ | ------------------------- |
| up to `500.0000000`           | `auto`     | 0      | Settled on submission     |
| up to `5000.0000000`          | `operator` | 1      | Operator signs off        |
| anything above `5000.0000000` | `dual`     | 2      | Operator, then compliance |

Tier limits are **inclusive** — an amount exactly at a limit stays in that tier,
and one stroop over moves up. Amounts are parsed to integer stroops
(`1 stroop = 0.0000001`) and compared as `BigInt`, because a rounding error here
would put a withdrawal into the wrong chain entirely.

Three rules carry the suite:

1. **The tier is pinned at request time.** A request already in flight keeps the
   chain it was admitted under, so re-reading it can never change how many
   approvals it needs.
2. **Levels are cleared in order, and the caller does not pick the level.** The
   server derives the next pending one, so there is no way to sign off on
   compliance before an operator has looked at it.
3. **Separation of duties.** One person cannot clear two levels of the same
   request, even when they hold both roles.

## Approvers

| Level | Name         | Roster                                |
| ----- | ------------ | ------------------------------------- |
| 1     | `operator`   | `ops-anna`, `ops-ben`, `lead-erin`    |
| 2     | `compliance` | `comp-carla`, `comp-dan`, `lead-erin` |

`lead-erin` sits on both rosters deliberately. She may clear either level, but
never both on the same request — which is what makes the separation-of-duties
rule load-bearing rather than a side effect of the rosters not overlapping. The
rule is per request: she can clear level 1 on one withdrawal and level 2 on
another.

## Endpoints

### `GET /policy`

The tiers and the roster for each level, readable without submitting anything.

### `POST /request`

Submits a withdrawal and returns its chain.

```json
{ "account": "GA_LARGE", "amount": "25000", "reference": "treasury sweep" }
```

Response — `201`:

```json
{
  "id": "b3d1...",
  "account": "GA_LARGE",
  "amount": "25000.0000000",
  "asset": "XLM",
  "reference": "treasury sweep",
  "tier": "dual",
  "levelsRequired": 2,
  "status": "pending_approval",
  "approvals": [],
  "approvalsRecorded": 0,
  "remainingLevels": 2,
  "nextLevel": {
    "level": 1,
    "name": "operator",
    "approvers": ["ops-anna", "ops-ben", "lead-erin"]
  },
  "rejection": null,
  "settledAt": null
}
```

A zero-level request comes back already `settled`, with `nextLevel: null` — there
is no intermediate state for it to sit in.

An amount that is not a positive decimal with at most 7 decimal places is a
`400`. A missing amount is refused rather than read as zero and dropped into the
`auto` tier.

### `POST /approve`

Clears the **next pending level**. The body names who is approving, not what.

```json
{ "id": "b3d1...", "approver": "ops-ben" }
```

Returns the updated request. When the last required level is cleared, `status`
becomes `settled` and `settledAt` is stamped.

| Response | Meaning                                                               |
| -------- | --------------------------------------------------------------------- |
| `200`    | Recorded                                                              |
| `403`    | `approver_not_authorised` — not on the roster for the pending level   |
| `403`    | `separation_of_duties` — this person already cleared an earlier level |
| `409`    | `request_closed` — already settled or rejected                        |
| `409`    | `no_approval_required` — a zero-level request never needed one        |
| `404`    | `request_not_found`                                                   |

A refusal is never a state change: nothing is recorded and the request stays
exactly where it was.

### `POST /reject`

Closes the request at whatever level it has reached. Only someone authorised for
the **currently pending** level may reject it.

```json
{ "id": "b3d1...", "approver": "comp-carla", "reason": "sanctions hit" }
```

The approvals already recorded are kept, so the record still shows how far it
got:

```json
{
  "status": "rejected",
  "approvals": [
    { "level": 1, "levelName": "operator", "approver": "ops-anna", "approvedAt": "..." }
  ],
  "rejection": {
    "approver": "comp-carla",
    "level": 2,
    "reason": "sanctions hit",
    "rejectedAt": "..."
  }
}
```

`reason` is optional and defaults to `null`. A rejected request cannot be
revived by approving it.

### `GET /request?id=<requestId>`

Where a withdrawal is in its chain. `nextLevel`, `remainingLevels` and
`approvalsRecorded` are derived from the approvals actually recorded rather than
stored, so they cannot drift out of step. Responses are copies — mutating one
cannot rewrite stored state.

## Run

```sh
node route.mjs
# withdrawal-chain-suite mock listening on http://localhost:4148/policy
```

Override the port with `PORT=5000 node route.mjs`.

```sh
curl localhost:4148/policy

ID=$(curl -s -X POST localhost:4148/request \
  -H 'content-type: application/json' \
  -d '{"account":"GA_LARGE","amount":"25000"}' | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

curl -X POST localhost:4148/approve -H 'content-type: application/json' \
  -d "{\"id\":\"$ID\",\"approver\":\"ops-ben\"}"

curl -X POST localhost:4148/approve -H 'content-type: application/json' \
  -d "{\"id\":\"$ID\",\"approver\":\"comp-carla\"}"

curl "localhost:4148/request?id=$ID"
```

## Test

```sh
node route.test.mjs
```

The tests walk all three tiers, check every limit boundary on both sides, drive
a two-level chain to settlement, and cover the cases the design exists for:
compliance cannot go first, a dual-role approver is blocked from clearing a
second level on the same request but not on a different one, a refusal records
nothing, a rejection preserves the approvals already collected, and a closed
request cannot be revived.
