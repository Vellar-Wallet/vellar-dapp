# Per-transaction amount cap policy (Issue #14 / A2)

A Soroban policy contract that rejects any **single** transfer whose amount
exceeds a cap configured at deploy time. The cap is denominated in **stroops**,
following the existing `contracts/policy-templates/spending-limit` precedent.

## How this differs from the cumulative spending-limit policy

These are two different rules answering two different questions, and this one is
deliberately not a variant of the other:

|          | `spending-limit` (existing)      | this policy (A2)                          |
| -------- | -------------------------------- | ----------------------------------------- |
| Question | "how much in total per window?"  | "how large may ONE transfer be?"          |
| State    | persists a running `spent` total | none - every call is judged fresh         |
| Time     | resets on a rolling window       | no time dimension at all                  |
| Rejects  | the transfer crossing the total  | the transfer that is individually too big |

With a cap of 10 XLM this policy permits 10 XLM now, 10 XLM a second later, and
10 XLM again: each is individually within the cap. It is a shape restriction on
single transfers, **not** a spending limit, and it bounds nothing over time.

Because `Signature::Policy` carries no secret, a per-transfer cap used alone
does not bound total loss - repeated capped transfers can still drain a wallet.
Deploy this rule alongside the cumulative `spending-limit` policy, or pair it
with an authenticated co-signer via the granting signer's `SignerLimits`,
whenever a bound on total outflow is required.

## Why stroops and not USD

The cap is a native-unit quantity and there is intentionally **no fiat option**.
A Soroban contract has no trustless price feed, so a USD-denominated rule could
only be enforced by trusting an oracle - which would make the policy's guarantee
only as strong as that oracle, and would let a stale or manipulated price move
the effective limit. Fiat denomination is a separate design discussion, not an
oracle bolted into this rule.

## Behaviour

Configuration is written once by the constructor and never mutated (there is no
setter - a cap the holder can raise in place guarantees nothing). Each instance
is bound to a single wallet; `install` and `policy__` reject any other wallet.

`policy__` classifies each authorization context and checks every classified
transfer **individually** against the cap:

- amount **under** the cap - allowed
- amount **exactly at** the cap - allowed (the bound is inclusive)
- amount **over** the cap - rejected with `NotAllowed`
- anything **unclassifiable** - rejected with `NotAllowed`

Deny-by-default covers a non-transfer function, a missing or non-`i128` amount,
a zero or negative amount, a non-contract context, a call targeting the wallet's
own admin surface, an empty context list, and a context list longer than
`MAX_CONTEXT_EVALUATION_LIMIT` (refused outright, so nothing can slip past the
cap by sitting beyond the evaluated bound).

Note that a batch of several individually-legal transfers is allowed even when
their sum exceeds the cap. That is correct for a per-transfer rule; bounding the
total is the cumulative policy's job.

### Arithmetic

The cap check is a pure comparison (`amount > config.max_transfer_amount`) on
values that are range-checked before use, so there is no accumulation and no
overflow path - a cap of `i128::MAX` against an amount of `i128::MAX` is
exercised in the tests. The release profile also keeps `overflow-checks = true`
as defence in depth, matching the audited workspace.

## Errors

| Code | Name            | Cause                                                   |
| ---- | --------------- | ------------------------------------------------------- |
| 1    | `NotAllowed`    | Single transfer over the cap, or unclassifiable context |
| 2    | `NotInstalled`  | `policy__` before `install`, or config missing          |
| 4    | `InvalidConfig` | Constructor given a cap below 1 stroop                  |
| 5    | `WrongWallet`   | Called by a wallet other than the bound one             |

## Test

```sh
cd contrib/contracts/per-transfer-cap
cargo test
```
