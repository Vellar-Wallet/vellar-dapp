// Mock GET route returning a page of sample items plus an opaque cursor
// pointing at the next page. No chain or DB access.
import http from "node:http";
import { pathToFileURL, URL } from "node:url";

const ITEMS = [
  { id: "itm_01", label: "Coffee subscription" },
  { id: "itm_02", label: "Domain renewal" },
  { id: "itm_03", label: "Cloud storage" },
  { id: "itm_04", label: "Team lunch" },
  { id: "itm_05", label: "Conference ticket" },
  { id: "itm_06", label: "Design contractor" },
  { id: "itm_07", label: "Office supplies" },
  { id: "itm_08", label: "Analytics plan" },
  { id: "itm_09", label: "Payment processor fee" },
  { id: "itm_10", label: "Hardware wallet" },
];

const PAGE_SIZE = 4;

// Callers must treat cursors as opaque. Encoding the offset in base64url keeps
// that honest: the value is not a number they can guess or arithmetic on.
function encodeCursor(offset) {
  return Buffer.from(`offset:${offset}`, "utf8").toString("base64url");
}

// Returns the offset, or null when the cursor is not one we issued.
function decodeCursor(rawCursor) {
  let decoded;
  try {
    decoded = Buffer.from(rawCursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const match = /^offset:(\d+)$/.exec(decoded);
  if (!match) return null;
  const offset = Number(match[1]);
  // An offset past the end is as meaningless as a malformed one. Offsets that
  // do not sit on a page boundary were never issued by this route either.
  if (offset > ITEMS.length || offset % PAGE_SIZE !== 0) return null;
  return offset;
}

export function handleRequest({ query = {} } = {}) {
  const rawCursor = query.cursor;
  const hasCursor = rawCursor !== undefined && rawCursor !== null && rawCursor !== "";

  const offset = hasCursor ? decodeCursor(rawCursor) : 0;
  if (offset === null) {
    return {
      status: 400,
      body: {
        error: "invalid_cursor",
        message: "cursor must be a value returned as nextCursor by a previous request",
      },
    };
  }

  const items = ITEMS.slice(offset, offset + PAGE_SIZE);
  const nextOffset = offset + items.length;
  const isLastPage = nextOffset >= ITEMS.length;

  return {
    status: 200,
    body: {
      items,
      nextCursor: isLastPage ? null : encodeCursor(nextOffset),
    },
  };
}

// pathToFileURL rather than a `file://` template: on Windows argv[1] is a
// drive path, which does not compare equal to import.meta.url otherwise.
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/cursor-page") {
      const query = Object.fromEntries(url.searchParams);
      const { status, body } = handleRequest({ query });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4054;
  server.listen(port, () => {
    console.log(`cursor-page mock listening on http://localhost:${port}/cursor-page`);
  });
}
