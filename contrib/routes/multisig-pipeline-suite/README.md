# Route suite: multisig proposal to execution pipeline (Issue #150)

Self contained route handlers covering the full pipeline: propose a transaction
against a multisig wallet, collect signer votes, and execute it once the
approving weight reaches the wallet threshold.

Everything is in memory in `route.mjs`. Nothing is signed and nothing is
submitted.

## Weights, not headcount

Signers carry **weights**, and `threshold` is the total approving weight
required — not a signer count. So "two of four signed" and "did we reach the
threshold" are different questions, and the suite answers the second one.

| Wallet         | Threshold | Signers                                   |
| -------------- | --------- | ----------------------------------------- |
| `GW_TEAM`      | 3 of 5    | `alice` 2, `bob` 1, `carol` 1, `dave` 1   |
| `GW_SOLO`      | 1 of 1    | `solo` 1                                  |
| `GW_UNANIMOUS` | 4 of 4    | `erin` 1, `frank` 1, `grace` 1, `heidi` 1 |

Three behaviours follow from that, and they are what the suite is really about:

1. **Proposing is signing.** A signer cannot propose a transaction they are not
   willing to sign, so the proposer's weight counts from the moment the proposal
   exists. On `GW_SOLO`, whose threshold one signer's weight already meets, the
   proposal comes back `ready` with no further votes.
2. **A proposal can die before everyone has voted.** Once `approvedWeight +
undecidedWeight` (reported as `maxAttainable`) drops below the threshold, the
   outcome is already decided. On `GW_UNANIMOUS` a single reject ends it, and
   the two signers who never voted cannot revive it.
3. **Execution latches.** Executing the same approved proposal twice is the
   classic multisig bug, so `/execute` is idempotent: the second call returns
   the original record with `alreadyExecuted: true`.

**Votes are final.** That is what makes both terminal states monotonic — weight
already approved cannot be withdrawn, and weight already rejected cannot be
reclaimed. A proposal that has reached the threshold can never fall back below
it.

## Status

`status` is derived from the current tally on every read, never stored:

| Status     | Condition                                      |
| ---------- | ---------------------------------------------- |
| `pending`  | Still reachable, threshold not yet met         |
| `ready`    | `approvedWeight >= threshold`                  |
| `rejected` | `maxAttainable < threshold` — cannot ever pass |
| `executed` | An execution record exists                     |

## Endpoints

### `GET /wallet?id=<walletId>`

Signers, weights and threshold.

```json
{
  "id": "GW_TEAM",
  "threshold": 3,
  "totalWeight": 5,
  "signers": [
    { "id": "alice", "weight": 2 },
    { "id": "bob", "weight": 1 }
  ]
}
```

An unknown wallet responds `404` with the list of known wallets.

### `POST /propose`

Opens a proposal. The proposer must be a signer; a non-signer is `403`
`not_a_signer`. `operation` is an opaque description of the transaction — the
pipeline is the subject here, not the operation body.

```json
{ "wallet": "GW_TEAM", "proposer": "alice", "operation": "pay 500 XLM to GA_VENDOR" }
```

Response — `201`:

```json
{
  "id": "9f2c...",
  "wallet": "GW_TEAM",
  "proposer": "alice",
  "operation": "pay 500 XLM to GA_VENDOR",
  "status": "pending",
  "threshold": 3,
  "totalWeight": 5,
  "approvedWeight": 2,
  "rejectedWeight": 0,
  "undecidedWeight": 3,
  "maxAttainable": 5,
  "votes": [{ "signer": "alice", "weight": 2, "vote": "approve", "votedAt": "..." }],
  "awaiting": ["bob", "carol", "dave"],
  "readyToExecute": false,
  "execution": null
}
```

### `POST /vote`

Records one signer's vote. `vote` is `approve` or `reject`.

```json
{ "id": "9f2c...", "signer": "bob", "vote": "approve" }
```

| Response | Meaning                                                             |
| -------- | ------------------------------------------------------------------- |
| `200`    | Recorded; the updated proposal comes back                           |
| `409`    | `already_voted` — votes are final, not overwritten                  |
| `409`    | `voting_closed` — the proposal is `ready`, `rejected` or `executed` |
| `403`    | `not_a_signer`                                                      |
| `404`    | `proposal_not_found`                                                |

`already_voted` carries `recordedVote` and `viaProposal`, the latter marking the
proposer's own approval recorded when they opened the proposal.

### `POST /execute`

Executes a proposal that has reached its threshold. The executor must be a
signer, but need not be one who voted.

```json
{ "id": "9f2c...", "executor": "dave" }
```

Response — `200`:

```json
{
  "status": "executed",
  "alreadyExecuted": false,
  "execution": {
    "txHash": "4b1e...",
    "executedBy": "dave",
    "executedAt": "...",
    "approvedWeight": 3,
    "threshold": 3,
    "approvedBy": ["alice", "bob"]
  }
}
```

The execution record **pins the tally it ran against**, so it cannot be read as
evidence for some other set of votes.

Executing early is `409` `threshold_not_reached` (with `awaiting` naming who is
left); executing a dead proposal is `409` `proposal_rejected`. Neither records
anything.

### `GET /proposal?id=<proposalId>`

The proposal with its live tally. Responses are copies — mutating one cannot
rewrite stored state.

## Run

```sh
node route.mjs
# multisig-pipeline-suite mock listening on http://localhost:4150/wallet?id=GW_TEAM
```

Override the port with `PORT=5000 node route.mjs`.

```sh
curl 'localhost:4150/wallet?id=GW_TEAM'

ID=$(curl -s -X POST localhost:4150/propose -H 'content-type: application/json' \
  -d '{"wallet":"GW_TEAM","proposer":"alice","operation":"pay 500 XLM"}' \
  | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

curl -X POST localhost:4150/vote -H 'content-type: application/json' \
  -d "{\"id\":\"$ID\",\"signer\":\"bob\",\"vote\":\"approve\"}"

curl -X POST localhost:4150/execute -H 'content-type: application/json' \
  -d "{\"id\":\"$ID\",\"executor\":\"dave\"}"
```

## Test

```sh
node route.test.mjs
```

The tests drive a proposal from open to executed on a weighted wallet, and cover
what the design exists for: a proposal passing on two of four signers because
the weight clears, voting closing the moment the threshold is met, a unanimous
wallet dying on one reject with two signers still unvoted, a solo wallet ready
at proposal time, a duplicate vote refused rather than overwritten, execution
refused before the threshold and after rejection, and a second `/execute`
returning the first result instead of running again.
