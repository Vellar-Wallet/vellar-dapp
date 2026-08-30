import http from "node:http";
import crypto from "node:crypto";

/**
 * Mock Route Suite: Notification Digest Batching Job (Issue #152)
 *
 * Individual notifications are collected per recipient and batched into a
 * single digest once a simulated time window elapses.
 *
 * There is no real clock here. Every call that depends on time takes an
 * explicit `time` (milliseconds), so a five minute window can be exercised in a
 * test without waiting five minutes. The simulated clock is per recipient and
 * monotonic: a call carrying a `time` earlier than the last one observed is
 * refused rather than quietly reopening a window that has already closed.
 *
 * Three decisions shape the batching:
 *
 *   - The window opens with the FIRST buffered notification and does not move.
 *     Restarting it on each arrival would be a debounce, and under a steady
 *     stream a debounce never fires at all -- the digest would be starved
 *     exactly when there is most to say.
 *   - A full buffer is due regardless of the window. The window bounds how long
 *     a notification waits; `maxBatch` bounds how large a single digest gets.
 *   - Emission is pull-based. `/notify` only buffers; the batching job calls
 *     `/flush`, which is what makes the job a job. The one exception is an
 *     urgent notification, which is interrupt-driven and emits on arrival.
 *
 * Everything is in memory; nothing is delivered anywhere.
 */

/** How long a digest waits before it is due. */
const WINDOW_MS = 300_000;

/** How many notifications may ride in one digest before it is due early. */
const MAX_BATCH = 5;

const PRIORITIES = ["normal", "urgent"];

/** recipient -> { notifications, windowOpenedAt, lastObservedTime } */
const buffers = new Map();

/** Every digest emitted, oldest first. */
const digests = [];

/** Clears all buffers and emitted digests. Exported for tests. */
export function resetState() {
  buffers.clear();
  digests.length = 0;
}

function badRequest(field, reason, extra = {}) {
  return { status: 400, payload: { error: "invalid_request", field, reason, ...extra } };
}

function bufferFor(recipient) {
  let buffer = buffers.get(recipient);
  if (!buffer) {
    buffer = { notifications: [], windowOpenedAt: null, lastObservedTime: null };
    buffers.set(recipient, buffer);
  }
  return buffer;
}

/**
 * Validates a recipient and a simulated timestamp together, since every
 * time-taking endpoint needs both and the monotonic check spans the two.
 *
 * Purely a check: it never moves the clock. Callers advance it themselves, and
 * only once the call is certain to succeed -- a refused call must leave the
 * clock exactly where it found it, or an invalid notification could strand a
 * later valid one by dragging `lastObservedTime` forward on its way out.
 */
function resolve(recipient, time) {
  if (typeof recipient !== "string" || recipient.trim() === "") {
    return { error: badRequest("recipient", "must be a non-empty string") };
  }
  if (!Number.isInteger(time) || time < 0) {
    return {
      error: badRequest("time", "must be a non-negative integer of milliseconds", {
        received: time === undefined ? null : String(time),
      }),
    };
  }

  const key = recipient.trim();
  const buffer = bufferFor(key);

  if (buffer.lastObservedTime !== null && time < buffer.lastObservedTime) {
    return {
      error: {
        status: 400,
        payload: {
          error: "time_went_backwards",
          recipient: key,
          received: time,
          lastObservedTime: buffer.lastObservedTime,
        },
      },
    };
  }

  return { recipient: key, buffer, now: time };
}

/**
 * Why a buffer is due, or `null` if it is not.
 *
 * A full buffer outranks an elapsed window: both may be true at once, and
 * "there are already five of these" is the more useful reason to report.
 */
function dueReasonFor(buffer, now) {
  if (buffer.notifications.length === 0) return null;
  if (buffer.notifications.length >= MAX_BATCH) return "batch_full";
  if (now - buffer.windowOpenedAt >= WINDOW_MS) return "window_elapsed";
  return null;
}

/** The buffer as reported to callers, with the window arithmetic done. */
function pendingView(recipient, buffer, now) {
  const open = buffer.notifications.length > 0;
  const reason = dueReasonFor(buffer, now);

  return {
    recipient,
    now,
    count: buffer.notifications.length,
    notifications: buffer.notifications.map((entry) => ({ ...entry })),
    windowMs: WINDOW_MS,
    maxBatch: MAX_BATCH,
    windowOpenedAt: buffer.windowOpenedAt,
    windowClosesAt: open ? buffer.windowOpenedAt + WINDOW_MS : null,
    msRemaining: open ? Math.max(0, buffer.windowOpenedAt + WINDOW_MS - now) : null,
    due: reason !== null,
    dueReason: reason,
  };
}

/**
 * Drains the buffer into a digest and closes the window.
 *
 * The digest pins the window it was emitted for, so a digest read back later
 * still says which batching decision produced it.
 */
function emit(recipient, buffer, now, reason) {
  const digest = {
    id: crypto.randomUUID(),
    recipient,
    reason,
    count: buffer.notifications.length,
    notifications: buffer.notifications.map((entry) => ({ ...entry })),
    windowOpenedAt: buffer.windowOpenedAt,
    windowMs: WINDOW_MS,
    emittedAt: now,
  };

  digests.push(digest);
  buffer.notifications = [];
  buffer.windowOpenedAt = null;
  return digest;
}

/**
 * `GET /policy` -- the batching rules in effect.
 */
export function getPolicy() {
  return {
    status: 200,
    payload: {
      windowMs: WINDOW_MS,
      maxBatch: MAX_BATCH,
      priorities: [...PRIORITIES],
      rule: "the window opens with the first buffered notification; a full buffer is due early; urgent notifications emit on arrival and take the pending batch with them",
    },
  };
}

/**
 * `POST /notify` -- buffer one notification.
 *
 * A `normal` notification is only buffered; the batching job emits it later.
 * An `urgent` one emits immediately and takes whatever is already buffered with
 * it -- the recipient is being interrupted regardless, so making the rest of
 * the batch wait out the window would be pure delay for no benefit.
 */
export function notify({ recipient, subject, kind, priority = "normal", time } = {}) {
  const resolved = resolve(recipient, time);
  if (resolved.error) return resolved.error;

  if (typeof subject !== "string" || subject.trim() === "") {
    return badRequest("subject", "must be a non-empty string");
  }
  if (kind !== undefined && (typeof kind !== "string" || kind.trim() === "")) {
    return badRequest("kind", "must be a non-empty string when provided");
  }
  if (!PRIORITIES.includes(priority)) {
    return badRequest("priority", `must be one of ${PRIORITIES.join(", ")}`, {
      received: String(priority),
    });
  }

  const { recipient: key, buffer, now } = resolved;

  // Past every check, so this call is going to succeed: the clock may move.
  buffer.lastObservedTime = now;

  const entry = {
    id: crypto.randomUUID(),
    kind: kind ? kind.trim() : "notice",
    subject: subject.trim(),
    priority,
    receivedAt: now,
  };

  // The window anchors to the first notification in the buffer and stays there.
  if (buffer.notifications.length === 0) buffer.windowOpenedAt = now;
  buffer.notifications.push(entry);

  if (priority === "urgent") {
    const digest = emit(key, buffer, now, "urgent");
    return {
      status: 201,
      payload: {
        buffered: false,
        notification: { ...entry },
        digest,
        pending: pendingView(key, buffer, now),
      },
    };
  }

  return {
    status: 201,
    payload: {
      buffered: true,
      notification: { ...entry },
      digest: null,
      pending: pendingView(key, buffer, now),
    },
  };
}

/**
 * `GET /pending?recipient=<id>&time=<ms>` -- what is waiting, and whether the
 * batching job should flush it yet.
 */
export function getPending(recipient, time) {
  const parsedTime = typeof time === "string" ? Number(time) : time;
  const resolved = resolve(recipient, parsedTime);
  if (resolved.error) return resolved.error;

  const { recipient: key, buffer, now } = resolved;
  return { status: 200, payload: pendingView(key, buffer, now) };
}

/**
 * `POST /flush` -- the batching job's tick.
 *
 * Emits the digest only if the buffer is due. Flushing early is refused with
 * the time still to run, so a job that ticks too often cannot fragment a window
 * into several undersized digests.
 */
export function flush({ recipient, time } = {}) {
  const resolved = resolve(recipient, time);
  if (resolved.error) return resolved.error;

  const { recipient: key, buffer, now } = resolved;

  if (buffer.notifications.length === 0) {
    return {
      status: 409,
      payload: { error: "nothing_pending", recipient: key, now, count: 0 },
    };
  }

  const reason = dueReasonFor(buffer, now);
  if (reason === null) {
    return {
      status: 409,
      payload: { error: "window_open", ...pendingView(key, buffer, now) },
    };
  }

  // Only a tick that actually emits counts as an observation of the clock.
  buffer.lastObservedTime = now;
  const digest = emit(key, buffer, now, reason);
  return { status: 200, payload: { digest, pending: pendingView(key, buffer, now) } };
}

/**
 * `GET /digests?recipient=<id>` -- digests already emitted, oldest first.
 * Omitting `recipient` returns every digest.
 */
export function getDigests(recipient) {
  if (recipient !== undefined && (typeof recipient !== "string" || recipient.trim() === "")) {
    return badRequest("recipient", "must be a non-empty string when provided");
  }

  const key = recipient?.trim();
  const matching = key ? digests.filter((digest) => digest.recipient === key) : digests;

  return {
    status: 200,
    payload: {
      recipient: key ?? null,
      count: matching.length,
      digests: matching.map((digest) => ({
        ...digest,
        notifications: digest.notifications.map((entry) => ({ ...entry })),
      })),
    },
  };
}

export function handleRequest(method, pathname, body, query) {
  if (method === "GET" && pathname === "/policy") return getPolicy();
  if (method === "GET" && pathname === "/pending") return getPending(query?.recipient, query?.time);
  if (method === "GET" && pathname === "/digests") return getDigests(query?.recipient);
  if (method === "POST" && pathname === "/notify") return notify(body ?? {});
  if (method === "POST" && pathname === "/flush") return flush(body ?? {});
  return { status: 404, payload: { error: "not_found" } };
}

const PORT = process.env.PORT || 4152;
if (process.argv[1] && process.argv[1].endsWith("route.mjs")) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const url = new URL(req.url, "http://localhost");
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const query = Object.fromEntries(url.searchParams);
      const { status, payload } = handleRequest(req.method, url.pathname, body, query);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  server.listen(PORT, () => {
    console.log(`notification-digest-suite mock listening on http://localhost:${PORT}/policy`);
  });
}
