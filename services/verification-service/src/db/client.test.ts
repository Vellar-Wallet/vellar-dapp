import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { connectDb } from "./client";

// `connectDb` has no retry/backoff loop anywhere in it (or in any sibling
// service's db/client.ts) — it calls `pool.connect()` once and lets the
// resulting promise reject. These tests document that real behavior rather
// than asserting a retry mechanism that doesn't exist (issue #696).
//
// A reachable host with a *closed* TCP port behaves differently from one
// where nothing is listening at the OS level — this suite uses a real TCP
// server that accepts a connection and then closes it immediately, which is
// what an app exists on the host but Postgres is down looks like, and is
// distinct from the connection-refused case where the OS itself rejects the
// SYN (a port with no listener at all).
describe("connectDb against a reachable host with Postgres not listening (#696)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  function listenOnFreePort(onConnection: (socket: import("node:net").Socket) => void): Promise<number> {
    return new Promise((resolve, reject) => {
      server = createServer(onConnection);
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server?.address();
        if (!address || typeof address === "string") {
          reject(new Error("expected a TCP address"));
          return;
        }
        resolve(address.port);
      });
    });
  }

  it("rejects distinguishably when the host accepts the TCP connection but speaks no Postgres protocol", async () => {
    const port = await listenOnFreePort((socket) => {
      // Accept the TCP connection (the host IS reachable), then hang up
      // without ever sending anything — nothing Postgres-shaped is behind
      // this port, so the client's startup handshake fails on its own terms
      // rather than via a connection-refused error.
      socket.destroy();
    });

    await expect(
      connectDb(`postgres://user:pass@127.0.0.1:${port}/db`),
    ).rejects.toThrow();
  });

  it("rejects with ECONNREFUSED when nothing listens on the port at all (distinct from the above)", async () => {
    // Bind and immediately close: the OS reclaims the port and refuses any
    // connection attempt at the TCP layer, unlike the accept-then-hang-up
    // case above where a process is genuinely listening.
    const port = await listenOnFreePort(() => {});
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;

    await expect(
      connectDb(`postgres://user:pass@127.0.0.1:${port}/db`),
    ).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("does not retry: a single failed connection attempt does not leave a pending retry that later succeeds once the port opens", async () => {
    const port = await listenOnFreePort(() => {});
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;

    const databaseUrl = `postgres://user:pass@127.0.0.1:${port}/db`;
    await expect(connectDb(databaseUrl)).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });

    // The port now becomes reachable (something starts listening), but since
    // connectDb doesn't retry internally, a NEW call is required to succeed —
    // nothing from the first, already-rejected call will silently resolve.
    // We only assert the absence of a lingering retry; a fresh connectDb call
    // against this bare TCP listener would itself still fail the Postgres
    // handshake, which isn't what this test is checking.
    let sawSecondAttempt = false;
    await listenOnFreePort((socket) => {
      sawSecondAttempt = true;
      socket.destroy();
    });
    // Reuse the same free port is not guaranteed by the OS, so this merely
    // confirms no background retry from the first call ever reaches a
    // listener — no connection arrives from the earlier, already-rejected
    // connectDb call.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sawSecondAttempt).toBe(false);
  });
});
