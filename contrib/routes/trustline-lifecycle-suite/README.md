# Trustline Lifecycle Suite

A dependency-free mock route for a trustline lifecycle. The handler uses deterministic, isolated state and returns a new state with each state-changing request.

## Routes

All routes accept JSON request bodies containing `account`, `assetCode`, and `issuer`.

- `POST /add` adds or replaces a trustline. Optional `balance` defaults to `"0"`.
- `POST /check-removable` reports whether the trustline can be removed. A trustline is removable only when its balance is exactly zero. A non-zero balance returns `removable: false` and reason `trustline_balance_must_be_zero`.
- `POST /remove` removes a zero-balance trustline. It rejects removal with status `409` whenever `/check-removable` reports it is not removable.

For direct use, import `createState` and `handleRequest` from `route.mjs`. Pass the returned `state` into the next call to keep the lifecycle immutable and deterministic.

## Test

```sh
node route.test.mjs
```

## Run As A Mock Server

```sh
node route.mjs
```

The server listens on port `4110`, or the port supplied through `PORT`.
