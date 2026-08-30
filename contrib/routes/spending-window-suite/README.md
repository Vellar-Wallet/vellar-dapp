# Route suite: rolling window spending limit reset (Issue #98)

Self contained route handlers that track cumulative sample spend per account
inside a rolling window and reset that window once it elapses.

Everything is in memory in `route.mjs`; no account is ever touched.

## How the window works

The window is **anchored**, not sliding. It opens on the first spend an account
makes and runs for exactly `windowMs` from that instant. Every spend inside it
accumulates against the same total. The first spend at or after the window's end
opens a fresh window anchored at that spend, with the total back at zero.

Two rules follow from that, and they are what the tests pin down:

- **A rejected spend changes nothing.** An over-limit spend is not recorded and
  does not extend or re-anchor the window.
- **Reading the window never opens one.** An elapsed window reads as inactive
  with a zero total, but the reset is only committed by the next spend — so a
  read cannot silently hand an account a fresh allowance.

Defaults are `limit: 1000` and `windowMs: 60000`.

Every endpoint accepts an optional `now` (epoch ms), which makes window elapse
deterministic in tests. It defaults to `Date.now()`.

## Endpoints

### `POST /spend`

Records a spend against the account's window.

Request:

```json
{ "account": "GA_SPENDER", "amount": 400, "now": 1700000000000 }
```

Response (accepted):

```json
{
  "account": "GA_SPENDER",
  "active": true,
  "limit": 1000,
  "windowMs": 60000,
  "spent": 400,
  "remaining": 600,
  "spendCount": 1,
  "windowStartedAt": 1700000000000,
  "windowEndsAt": 1700000060000,
  "msRemaining": 60000,
  "accepted": 400,
  "windowReset": false
}
```

`windowReset` is `true` when this spend opened a new window because the previous
one had elapsed, so a caller can see the reset without diffing timestamps. It
stays `false` for an account's first ever spend, which starts a window rather
than resetting one.

Response (over the limit, `429`) — the window is reported unchanged, alongside
what was attempted:

```json
{
  "error": "limit_exceeded",
  "spent": 750,
  "remaining": 250,
  "attempted": 300,
  "wouldBeSpent": 1050,
  "windowStartedAt": 1700000000000
}
```

Rejected with `400`: a missing `account`, an `amount` that is not a positive
finite number, a non-numeric `now`, and a `now` that falls before the start of a
live window (`now_before_window_start` — time running backwards would make the
elapse check meaningless).

### `GET /window?account=<id>&now=<ms>`

Reads the window without touching it. Adds `elapsed`, which is `true` when the
account has spent before but its window has run out:

```json
{
  "account": "GA_SPENDER",
  "active": false,
  "elapsed": true,
  "spent": 0,
  "remaining": 1000,
  "windowStartedAt": null,
  "windowEndsAt": null,
  "msRemaining": 0
}
```

An account that has never spent reads the same way with `elapsed: false`.

### `POST /reset`

Drops an account's window outright.

Request:

```json
{ "account": "GA_SPENDER" }
```

Response — `cleared` reports whether a window actually existed:

```json
{ "account": "GA_SPENDER", "cleared": true }
```

## Run

```sh
node route.mjs
# spending-window-suite mock listening on http://localhost:4098/window
```

## Testing

Drives a fixed clock across the window boundary, covering accumulation inside
one window, an over-limit refusal leaving the total untouched, a spend that
exactly reaches the limit, the state one millisecond before the boundary, the
reset at and after it, skipping several windows at once, per-account isolation,
and validation:

```sh
node route.test.mjs
```
