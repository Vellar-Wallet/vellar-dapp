import { describe, expect, it, vi } from "vitest";
import {
  createVerificationClient,
  isClientTimeoutError,
  isServerBuildTimeoutError,
  trustSignal,
  VerificationApiError,
  VerificationClientTimeoutError,
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

  describe("client-side request timeout vs server build timeout (#550)", () => {
    it("fails fast with VerificationClientTimeoutError when a request hangs at the network level with no response", async () => {
      let abortedSignal = false;
      const hungFetch = vi.fn<typeof fetch>((_input, init) => {
        init?.signal?.addEventListener("abort", () => {
          abortedSignal = true;
        });
        // Never resolves — simulates a hung network socket with no response at all
        return new Promise<Response>(() => {});
      });

      const client = createVerificationClient({
        apiUrl: "https://api.test",
        fetch: hungFetch,
        timeoutMs: 25,
      });

      const err = (await client.getStatus(C1).catch((e: unknown) => e)) as unknown;
      expect(err).toBeInstanceOf(VerificationClientTimeoutError);
      expect(isClientTimeoutError(err)).toBe(true);
      expect(isServerBuildTimeoutError(err)).toBe(false);
      expect(abortedSignal).toBe(true);
      expect(err).toMatchObject({
        name: "VerificationClientTimeoutError",
        code: "CLIENT_TIMEOUT",
        timeoutKind: "client_request_timeout",
        status: 0,
        timeoutMs: 25,
        path: `/${C1}/status`,
      });
    });

    it("distinguishes a client-side request timeout from a server-reported build timeout", async () => {
      const serverBuildTimeoutFetch = vi.fn<typeof fetch>(async () =>
        jsonResponse(
          {
            error: "build_timeout",
            message: "Verification worker build exceeded maximum execution time.",
          },
          504,
        ),
      );

      const client = createVerificationClient({
        apiUrl: "https://api.test",
        fetch: serverBuildTimeoutFetch,
        timeoutMs: 5_000,
      });

      const serverErr = (await client
        .submit(submitInput)
        .catch((e: unknown) => e)) as VerificationApiError;

      expect(serverErr).toBeInstanceOf(VerificationApiError);
      expect(serverErr).not.toBeInstanceOf(VerificationClientTimeoutError);
      expect(isClientTimeoutError(serverErr)).toBe(false);
      expect(isServerBuildTimeoutError(serverErr)).toBe(true);
      expect(serverErr).toMatchObject({
        name: "VerificationApiError",
        status: 504,
        code: "build_timeout",
        timeoutKind: "server_build_timeout",
      });

      // Compare against a client-side timeout via per-request override
      const hungClient = createVerificationClient({
        apiUrl: "https://api.test",
        fetch: () => new Promise<Response>(() => {}),
        timeoutMs: 5_000,
      });
      const clientErr = (await hungClient
        .submit(submitInput, { timeoutMs: 20 })
        .catch((e: unknown) => e)) as VerificationClientTimeoutError;

      expect(isClientTimeoutError(clientErr)).toBe(true);
      expect(isServerBuildTimeoutError(clientErr)).toBe(false);
      expect(clientErr.code).not.toBe(serverErr.code);
      expect(clientErr.timeoutKind).not.toBe(serverErr.timeoutKind);
    });
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
});
