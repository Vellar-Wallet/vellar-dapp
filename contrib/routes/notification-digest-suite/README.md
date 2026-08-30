# Route suite: notification digest batching job (Issue #152)

Self contained route handlers that collect individual notifications per
recipient and batch them into a **single digest** once a simulated time window
elapses.

Everything is in memory in `route.mjs`. Nothing is delivered anywhere.

## There is no real clock

Every call that depends on time takes an explicit `time` in milliseconds, so a
five minute window can be exercised in a test without waiting five minutes.

The simulated clock is **per recipient and monotonic**. A call carrying a `time`
earlier than the last one observed for that recipient is refused with `400`
`time_went_backwards`, rather than quietly reopening a window that has already
closed. Reads check the clock but do not advance it, so a query far in the
future cannot strand a later write.

A missing or non-integer `time` is a `400`. It is never defaulted to a real
clock reading — the caller owns the clock, and that is the point.

## How the batching works

| Setting    | Value            |
| ---------- | ---------------- |
| `windowMs` | `300000` (5 min) |
| `maxBatch` | `5`              |

Three decisions shape it:

1. **The window opens with the first buffered notification and does not move.**
   Restarting it on each arrival would be a debounce, and under a steady stream
   a debounce never fires — the digest would be starved exactly when there is
   most to say. Later arrivals join the batch; they do not push the deadline
   out.
2. **A full buffer is due regardless of the window.** The window bounds how long
   a notification waits; `maxBatch` bounds how large one digest gets. When both
   conditions hold, `batch_full` is the reason reported.
3. **Emission is pull-based.** `/notify` only buffers. The batching job calls
   `/flush`, which is what makes the job a job.

### The one exception: urgent

An `urgent` notification is interrupt-driven. It emits on arrival **and takes
whatever is already buffered with it** — the recipient is being interrupted
regardless, so making the rest of the batch wait out the window would be pure
delay for no benefit. The buffer is drained and the window closed behind it.

## Endpoints

### `GET /policy`

The batching rules in effect: `windowMs`, `maxBatch`, and the valid priorities.

### `POST /notify`

Buffers one notification.

```json
{
  "recipient": "alice",
  "subject": "Payment received",
  "kind": "payment",
  "priority": "normal",
  "time": 1000000
}
```

`kind` is optional and defaults to `"notice"`; `priority` is optional and
defaults to `"normal"`.

Response — `201`:

```json
{
  "buffered": true,
  "notification": {
    "id": "...",
    "kind": "payment",
    "subject": "Payment received",
    "priority": "normal",
    "receivedAt": 1000000
  },
  "digest": null,
  "pending": {
    "recipient": "alice",
    "count": 1,
    "windowOpenedAt": 1000000,
    "windowClosesAt": 1300000,
    "msRemaining": 300000,
    "due": false,
    "dueReason": null
  }
}
```

For an `urgent` notification, `buffered` is `false` and `digest` carries the
digest that was emitted on the spot.

### `GET /pending?recipient=<id>&time=<ms>`

What is waiting, and whether the job should flush it yet. `due` and `dueReason`
(`window_elapsed` or `batch_full`) are computed from the buffer on every read,
never stored.

### `POST /flush`

The batching job's tick.

```json
{ "recipient": "alice", "time": 1300000 }
```

| Response | Meaning                                                      |
| -------- | ------------------------------------------------------------ |
| `200`    | Digest emitted; the drained buffer comes back alongside it   |
| `409`    | `window_open` — not due yet, with `msRemaining` still to run |
| `409`    | `nothing_pending` — the buffer is empty                      |
| `400`    | `time_went_backwards`                                        |

Flushing early is refused so a job that ticks too often cannot fragment one
window into several undersized digests. A refusal emits nothing.

The digest pins the window it was emitted for:

```json
{
  "id": "7c11...",
  "recipient": "alice",
  "reason": "window_elapsed",
  "count": 2,
  "notifications": [{ "subject": "Payment received", "...": "..." }],
  "windowOpenedAt": 1000000,
  "windowMs": 300000,
  "emittedAt": 1300000
}
```

### `GET /digests?recipient=<id>`

Digests already emitted, oldest first. Omitting `recipient` returns every
digest. An unknown recipient is an empty list, not an error. Responses are
copies — mutating one cannot rewrite stored state.

## Run

```sh
node route.mjs
# notification-digest-suite mock listening on http://localhost:4152/policy
```

Override the port with `PORT=5000 node route.mjs`.

```sh
curl -X POST localhost:4152/notify -H 'content-type: application/json' \
  -d '{"recipient":"alice","subject":"Payment received","time":1000000}'

curl -X POST localhost:4152/notify -H 'content-type: application/json' \
  -d '{"recipient":"alice","subject":"Trustline added","time":1000100}'

# Not due yet -> 409 window_open
curl -X POST localhost:4152/flush -H 'content-type: application/json' \
  -d '{"recipient":"alice","time":1000200}'

# The window has elapsed -> one digest holding both
curl -X POST localhost:4152/flush -H 'content-type: application/json' \
  -d '{"recipient":"alice","time":1300000}'

curl 'localhost:4152/digests?recipient=alice'
```

## Test

```sh
node route.test.mjs
```

The tests cover the window staying anchored to the first arrival across three
notifications, the boundary one millisecond either side of the deadline, a full
buffer going due early and outranking the window as the reported reason, an
urgent notification sweeping up the pending batch, a backdated timestamp being
refused without buffering anything, per-recipient isolation of buffers and
clocks, and that a mutated response cannot rewrite stored state.
