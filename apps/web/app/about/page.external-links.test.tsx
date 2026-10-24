import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import About from "./page";

/**
 * Finds every externally-reachable (http/https) link rendered by the About
 * page. `mailto:` and other non-http(s) schemes are intentionally excluded —
 * there is no "200 OK" for those to assert on.
 */
function getExternalLinks(): string[] {
  const { container } = render(<About />);
  const hrefs = Array.from(container.querySelectorAll("a[href]")).map((a) =>
    a.getAttribute("href"),
  );
  const external = hrefs.filter(
    (href): href is string => !!href && /^https?:\/\//.test(href),
  );
  return Array.from(new Set(external));
}

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 2;

/**
 * Checks that `url` resolves to a live, non-error page.
 *
 * - Tries HEAD first (cheap), falls back to GET if the server doesn't
 *   support HEAD (some CDNs/doc hosts return 405/501 for it).
 * - Retries once on a transient network error (DNS hiccup, reset, timeout)
 *   before giving up, so a single flaky blip doesn't fail CI.
 * - Only a genuine network failure (not an HTTP error status) is tolerated
 *   this way — a real 404/410/5xx on the final attempt still fails the test,
 *   since that's exactly the regression this test exists to catch.
 */
async function checkLinkIsLive(url: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  let lastError: unknown;

  // jsdom's fetch stub validates `signal` against its own realm's
  // AbortSignal class, which rejects Node's native AbortController/
  // AbortSignal.timeout() as "not an instance of AbortSignal". A
  // Promise.race timeout avoids the cross-realm `signal` option entirely.
  const withTimeout = <T,>(promise: Promise<T>): Promise<T> =>
    Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out after ${REQUEST_TIMEOUT_MS}ms`)), REQUEST_TIMEOUT_MS),
      ),
    ]);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      let response = await withTimeout(fetch(url, { method: "HEAD", redirect: "follow" }));

      if (response.status === 405 || response.status === 501) {
        response = await withTimeout(fetch(url, { method: "GET", redirect: "follow" }));
      }

      return { ok: response.status < 400, status: response.status };
    } catch (error) {
      lastError = error;
      // Loop again for a retry, unless this was the last attempt.
    }
  }

  return { ok: false, error: lastError instanceof Error ? lastError.message : String(lastError) };
}

describe("About page external links", () => {
  const links = getExternalLinks();

  it("finds at least one external link to verify", () => {
    expect(links.length).toBeGreaterThan(0);
  });

  for (const url of links) {
    it(
      `"${url}" resolves to a live, non-error page`,
      { timeout: REQUEST_TIMEOUT_MS * MAX_ATTEMPTS + 2_000 },
      async () => {
        const result = await checkLinkIsLive(url);

        if (!result.ok && result.error) {
          throw new Error(
            `Could not reach "${url}" after ${MAX_ATTEMPTS} attempt(s): ${result.error}. ` +
              `This likely means either the link is broken or the test environment has no ` +
              `network access to this host.`,
          );
        }

        expect(result.status, `expected "${url}" to not 404/error, got status ${result.status}`).toBeLessThan(400);
      },
    );
  }
});
