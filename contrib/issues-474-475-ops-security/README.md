# Ops/security triage: issues #474 and #475

Work for:
- [#474](https://github.com/Vellar-Wallet/vellar-dapp/issues/474): single points of failure (sponsor key, npm publish, Render/DNS account, M5 multisig attestor).
- [#475](https://github.com/Vellar-Wallet/vellar-dapp/issues/475): free-tier Postgres expiry.

See [`decisions.md`](decisions.md) for the triage, the rotation/recovery
procedures recorded for #474, the re-verification of the RA-4 fail-closed
boot guard for #475, and the explicit list of what's still open in both
(mainly dashboard/account actions that need access this PR doesn't have).
