# Issue 319 — Worker Service Queue Consumer Chaos Tests

Chaos test suite verifying worker consumer crash recovery, lock releases, and unacknowledged job retries without data loss.

## Chaos Scenario Specification
1. Job is enqueued into the worker queue (`status="submitted"`).
2. Worker Consumer 1 claims job (`status="building"`), starts processing.
3. Consumer 1 process is forcibly killed mid-execution (simulated crash).
4. Lock monitor releases expired claim or new Consumer 2 reclaims unacknowledged job.
5. Consumer 2 resumes execution, finishes build comparison, and updates final status (`verified`).
6. Zero jobs lost or stuck permanently in `building` state.
