# Transaction Submission Load Testing

> **Status: the load-test harness does not currently exist.** There is no
> `contrib/load-test-submission.ts` and no root `test:load` script, so there is
> nothing to run today. Both were deleted in commit `44d8ce1`; see
> [`docs/ci-baseline.md`](./ci-baseline.md) for why and for the CI fallout. The
> measurements below are **historical results**, not current guarantees.

This document describes the load test that was written for transaction
submission under burst traffic (Issue #318), and what it measured.

## What the harness did

The removed harness evaluated system behavior under increasing levels of
concurrency (for example 1, 5, 10, 25 and 50 concurrent submitters).

It measured:

- **Throughput**: Requests Per Second (RPS)
- **Latency percentiles**: p50, p95 and p99 latency in milliseconds
- **Error rates**: percentage of failed submissions due to RPC rate limits or network congestion
- **Bottleneck detection**: the concurrency level at which the error rate exceeds the maximum
  allowed SLA threshold (default: 5%)

## Running a load test today

You can't: the commands that used to be documented here (`pnpm test:load` and
running the harness directly with `tsx`) fail because their targets are gone.
To load test submission again, restore a harness first, then re-add the CI step
that was removed with it.

## Continuous Integration (CI)

Not currently run in CI. The harness and the root `test:load` script were
removed in `44d8ce1`, so the CI step that called it was removed too (see
[`docs/ci-baseline.md`](./ci-baseline.md), "Load-test step"). Restore the
harness before re-adding the step.

## Past results (historical, not current)

These figures come from runs of the removed harness against standard testnet RPC
conditions. They are kept for context only, and may not reflect today's code or
RPC behavior.

- **Concurrency 1 - 10**: low latency (p50 ~ 25ms, p95 ~ 65ms) with < 1% error rate.
- **Concurrency 10 - 25**: moderate queueing; latency rises to p95 ~ 140ms with the error rate
  staying under 3%.
- **Concurrency 25+**: bottlenecks emerge as Stellar RPC rate limits and worker submission
  concurrency saturate. Error rates exceed the 5% SLA threshold if exponential backoff / circuit
  breaker is not engaged.
