import http from "node:http";

// In-memory data store for allowlists and denylists per account:
// Map<accountAddress, { allowlist: Set<recipientAddress>, denylist: Set<recipientAddress> }>
const accountLists = new Map();

function getOrCreateAccountLists(account) {
  if (!accountLists.has(account)) {
    accountLists.set(account, {
      allowlist: new Set(),
      denylist: new Set(),
    });
  }
  return accountLists.get(account);
}

export function addToList(body) {
  const { account, listType, recipient } = body || {};
  if (!account || !listType || !recipient) {
    return { status: 400, body: { error: "account, listType, and recipient are required" } };
  }

  const normalizedType = String(listType).toLowerCase();
  if (normalizedType !== "allowlist" && normalizedType !== "denylist") {
    return { status: 400, body: { error: "listType must be 'allowlist' or 'denylist'" } };
  }

  const lists = getOrCreateAccountLists(account);
  lists[normalizedType].add(recipient);

  return {
    status: 200,
    body: {
      success: true,
      account,
      listType: normalizedType,
      recipient,
      message: `Successfully added ${recipient} to ${normalizedType} for account ${account}`,
    },
  };
}

export function removeFromList(body) {
  const { account, listType, recipient } = body || {};
  if (!account || !listType || !recipient) {
    return { status: 400, body: { error: "account, listType, and recipient are required" } };
  }

  const normalizedType = String(listType).toLowerCase();
  if (normalizedType !== "allowlist" && normalizedType !== "denylist") {
    return { status: 400, body: { error: "listType must be 'allowlist' or 'denylist'" } };
  }

  const lists = accountLists.get(account);
  if (!lists || !lists[normalizedType].has(recipient)) {
    return { status: 404, body: { error: `Recipient ${recipient} not found on ${normalizedType} for account ${account}` } };
  }

  lists[normalizedType].delete(recipient);

  return {
    status: 200,
    body: {
      success: true,
      account,
      listType: normalizedType,
      recipient,
      message: `Successfully removed ${recipient} from ${normalizedType} for account ${account}`,
    },
  };
}

export function checkTransfer(data) {
  const { account, recipient, amount } = data || {};
  if (!account || !recipient) {
    return { status: 400, body: { error: "account and recipient are required" } };
  }

  const lists = accountLists.get(account) || { allowlist: new Set(), denylist: new Set() };

  // Rule 1: Denylist ALWAYS takes precedence. If recipient is on denylist, reject.
  if (lists.denylist.has(recipient)) {
    return {
      status: 200,
      body: {
        allowed: false,
        account,
        recipient,
        amount: amount || null,
        reason: "Recipient is on the denylist (denylist takes precedence over allowlist)",
      },
    };
  }

  // Rule 2: If allowlist is configured and non-empty, recipient MUST be on allowlist.
  if (lists.allowlist.size > 0 && !lists.allowlist.has(recipient)) {
    return {
      status: 200,
      body: {
        allowed: false,
        account,
        recipient,
        amount: amount || null,
        reason: "Recipient is not on the allowlist",
      },
    };
  }

  // Otherwise, transfer is allowed.
  return {
    status: 200,
    body: {
      allowed: true,
      account,
      recipient,
      amount: amount || null,
      reason: null,
    },
  };
}

export function clearLists() {
  accountLists.clear();
}

export function handleRequest(method, urlPath, body, query) {
  if (method === "POST" && urlPath === "/add-to-list") return addToList(body);
  if (method === "POST" && urlPath === "/remove-from-list") return removeFromList(body);
  if (method === "POST" && urlPath === "/check-transfer") return checkTransfer(body);
  if (method === "GET" && urlPath === "/check-transfer") return checkTransfer(query);
  return { status: 404, body: { error: "not_found" } };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    let bodyData = "";
    req.on("data", (chunk) => (bodyData += chunk));
    req.on("end", () => {
      let parsedBody;
      try {
        parsedBody = bodyData ? JSON.parse(bodyData) : undefined;
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid_json" }));
      }

      const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const queryParams = Object.fromEntries(urlObj.searchParams);
      const { status, body: responseBody } = handleRequest(req.method, urlObj.pathname, parsedBody, queryParams);

      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responseBody));
    });
  });

  const port = process.env.PORT || 4104;
  server.listen(port, () => {
    console.log(`transfer-list-suite route server listening on http://localhost:${port}`);
  });
}
