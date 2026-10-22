import { describe, expect, it, vi } from "vitest";
import {
  ClientTimeoutError,
  createVerificationClient,
  trustSignal,
  VerificationApiError,
  type SubmitVerificationInput,
} from "./index";

const C1 = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const submitInput: SubmitVerificationInput = {
  contractId: C1,
  sourceType: "repo",
  repoUrl: "https://github.com/example/contract",
  commitHash: "a1b2c3d",
  toolchainVersion: "1.81.0",
};

describe("createVerificationClient", () => {
  it("submits to /verification/submit and returns the record", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ record: { id: "r1", contractId: C1, status: "submitted" } }, 201),
    );
    const client = createVerificationClient({ apiUrl: "https://api.test/", fetch: fetchMock });

    const record = await client.submit(submitInput);
    expect(record.id).toBe("r1");

    const [url, init] = fetchMock.mock.calls[0]!;
    // Trailing slash on apiUrl is normalized (no double slash).
    expect(url).toBe("https://api.test/verification/submit");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toMatchObject({ contractId: C1, sourceType: "repo" });
  });

  it("fetches history from /verification/:contractId", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ records: [{ id: "r2", contractId: C1, status: "verified" }] }),
    );
    const client = createVerificationClient({ apiUrl: "https://api.test", fetch: fetchMock });
    const history = await client.getHistory(C1);
    expect(history).toHaveLength(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(`https://api.test/verification/${C1}`);
  });

  it("fetches status from /verification/:contractId/status", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ contractId: C1, status: "verified", recordId: "r2" }),
    );
    const client = createVerificationClient({ apiUrl: "https://api.test", fetch: fetchMock });
    const status = await client.getStatus(C1);
    expect(status.status).toBe("verified");
    expect(fetchMock.mock.calls[0]![0]).toBe(`https://api.test/verification/${C1}/status`);
  });

  it("throws a typed VerificationApiError on a non-2xx response", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ error: "invalid_body" }, 400));
    const client = createVerificationClient({ apiUrl: "https://api.test", fetch: fetchMock });
    await expect(client.submit(submitInput)).rejects.toMatchObject({
      name: "VerificationApiError",
      status: 400,
      code: "invalid_body",
    });
  });

  it("wraps a network failure as VerificationApiError with status 0", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    const client = createVerificationClient({ apiUrl: "https://api.test", fetch: fetchMock });
    await expect(client.getStatus(C1)).rejects.toBeInstanceOf(VerificationApiError);
    await expect(client.getStatus(C1)).rejects.toMatchObject({ status: 0 });
  });

  it("url-encodes the contract id in path lookups", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ contractId: "a/b", status: "unverified" }),
    );
    const client = createVerificationClient({ apiUrl: "https://api.test", fetch: fetchMock });
    await client.getStatus("a/b");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.test/verification/a%2Fb/status");
  });
});

describe("trustSignal", () => {
  it("maps each status to a stable label + tone", () => {
    expect(trustSignal("verified")).toEqual({ label: "Verified source", tone: "verified" });
    expect(trustSignal("failed")).toEqual({ label: "Verification failed", tone: "warning" });
    expect(trustSignal("submitted").tone).toBe("pending");
    expect(trustSignal("building").tone).toBe("pending");
    expect(trustSignal("unverified")).toEqual({ label: "Unverified", tone: "neutral" });
  });

  it("gives never-verified (unverified) a distinct, lower-severity tone than explicitly-failed verification (#587)", () => {
    const unverified = trustSignal("unverified");
    const failed = trustSignal("failed");
    expect(unverified.tone).toBe("neutral");
    expect(failed.tone).toBe("warning");
    expect(unverified.tone).not.toBe(failed.tone);
    expect(unverified.label).not.toBe(failed.label);
  });

  it("treats dead_letter as a failure, not as unverified/neutral (#587)", () => {
    // A dead_letter job genuinely failed after exhausting retries; it must
    // not silently fall through to the unverified default, which would
    // misrepresent a confirmed failure as an unchecked contract.
    expect(trustSignal("dead_letter")).toEqual(trustSignal("failed"));
    expect(trustSignal("dead_letter").tone).not.toBe(trustSignal("unverified").tone);
  });
});

function hangingFetch(): typeof fetch {
  return vi.fn<typeof fetch>(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
  ) as unknown as typeof fetch;
}

describe("client-side timeout (issue #550)", () => {
  it("throws ClientTimeoutError when the network request hangs with no response", async () => {
    const client = createVerificationClient({
      apiUrl: "https://api.test",
      fetch: hangingFetch(),
      timeoutMs: 50,
    });
    const err = await client.getStatus(C1).catch((e) => e);
    expect(err).toBeInstanceOf(ClientTimeoutError);
    expect(err.name).toBe("ClientTimeoutError");
    expect(err.code).toBe("client_timeout");
    expect(err.timeoutMs).toBe(50);
  });

  it("ClientTimeoutError is distinguishable from a server-reported build-timeout", async () => {
    // Server-reported build-timeout arrives as a normal API error response.
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: "build_timeout", message: "Build timed out" }, 504),
    );
    const client = createVerificationClient({ apiUrl: "https://api.test", fetch: fetchMock });
    const serverErr = await client.submit(submitInput).catch((e) => e);
    expect(serverErr).toBeInstanceOf(VerificationApiError);
    expect(serverErr.name).toBe("VerificationApiError");
    expect(serverErr.status).toBe(504);

    // Client-side timeout is a distinct class.
    const hangClient = createVerificationClient({
      apiUrl: "https://api.test",
      fetch: hangingFetch(),
      timeoutMs: 50,
    });
    const clientErr = await hangClient.getStatus(C1).catch((e) => e);
    expect(clientErr).toBeInstanceOf(ClientTimeoutError);
    expect(clientErr).not.toBeInstanceOf(VerificationApiError);
  });

  it("does not timeout when the response arrives within the window", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ contractId: C1, status: "verified" }),
    );
    const client = createVerificationClient({
      apiUrl: "https://api.test",
      fetch: fetchMock,
      timeoutMs: 5000,
    });
    const status = await client.getStatus(C1);
    expect(status.status).toBe("verified");
  });

  it("uses default 30s timeout when not specified", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ contractId: C1, status: "verified" }),
    );
    const client = createVerificationClient({ apiUrl: "https://api.test", fetch: fetchMock });
    await client.getStatus(C1);
    // Request completed — no timeout error.
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
