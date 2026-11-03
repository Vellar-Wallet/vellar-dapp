# M5 probe and cap reference

Tests for the assumptions behind the M5 threshold attestor
([`docs/design-m5-threshold-attestor.md`](../../docs/design-m5-threshold-attestor.md)). **Not a
production contract and not part of the audited `contracts/` workspace** (it is its own Cargo
workspace so it never joins `contracts/Cargo.toml`).

## What it checks

`src/lib.rs` is one small contract that plays three roles when deployed several times: the
**attestor** (a custom account whose `__check_auth` is under test), a **registry stand-in**
(`revoke` / `upsert` that require the attestor's authorisation, optionally failing or nesting a
second authorised call), and a protocol **canary**. No signatures are checked: `Sig::Single(i)` and
`Sig::Pair` stand for "one verified signature from signer `i`" and "two verified signatures". The
real attestor verifies signatures first and then applies exactly these rules.

| Layer          | Where                                 | What it proves                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests     | `src/test.rs` (`cargo test --locked`) | The cap rules, with every refusal asserting the signer's counter is **byte-for-byte unchanged**: another function, another registry, an extra context, two revokes, a wrong argument count, a different account, a contract-creation context, no context, no bound registry; the 3-per-window cap; the 17,279 / 17,280 ledger boundary; independent allowances; a two-signature revoke consuming no allowance |
| On-chain probe | `run-probe.mjs` (`pnpm m5:probe`)     | On the **real testnet host**: `__check_auth` can write instance and persistent storage, extend a TTL and emit an event; the 4th single-signer revoke is refused; each context rule is refused on real authorisation contexts; and a revoke that is **authorised and then fails in the registry call leaves the signer's counter unchanged** (rollback)                                                        |

For every refusal the runner also force-submits a transaction with a hand-widened footprint, so
there is a real FAILED transaction on-chain to look up, not only a simulation error.

## Run it

```sh
pnpm m5:probe
```

Needs the Rust toolchain (the crate pins 1.94.0 and `wasm32v1-none` in `rust-toolchain.toml`) and
network access to testnet. It builds with `cargo build --locked`, creates a **fresh throwaway key**
funded by friendbot, deploys the probe, and exits 1 if any check fails. It refuses to run against
anything but the testnet passphrase. `results.json` (git-ignored) holds the contract ids and every
transaction hash. Set `M5_PROBE_SKIP_BUILD=1` to reuse an existing build.

## When to run it

- **After any Stellar protocol upgrade.** A change in what `__check_auth` may do would silently break
  the cap design. The script prints the protocol version it ran on and warns if that version has not
  been verified before (`VERIFIED_PROTOCOLS` in `run-probe.mjs`).
- Before building on the design, and in the testnet rehearsal against the final attestor.
- `.github/workflows/m5-probe.yml` runs it weekly and on demand. GitHub only runs scheduled
  workflows from the default branch, so the schedule is inert until that file is on it.

## Verified on

Protocol **29** (testnet and mainnet both reported 29 on 2026-11-02).

## What it does not prove

It does not test signature verification, behaviour on a protocol it has not run on, or anything
about mainnet itself (it never touches mainnet; it only reads mainnet's protocol version).
