import http from "node:http";
import { pathToFileURL } from "node:url";

const DEFAULT_ACCOUNT = "GTESTACCOUNT";
const DEFAULT_ASSET_CODE = "USD";
const DEFAULT_ISSUER = "GTESTISSUER";

function response(status, body, state) {
  return { status, body, state };
}

function keyOf({ account, assetCode, issuer }) {
  return `${account}:${assetCode}:${issuer}`;
}

function validIdentity(body) {
  return body && body.account && body.assetCode && body.issuer;
}

function findTrustline(state, identity) {
  const key = keyOf(identity);
  return state.trustlines.find((trustline) => keyOf(trustline) === key);
}

function balanceValue(balance) {
  const value = Number(balance);
  return Number.isFinite(value) ? value : NaN;
}

function removable(trustline) {
  if (balanceValue(trustline.balance) !== 0) {
    return {
      removable: false,
      reason: "trustline_balance_must_be_zero",
    };
  }
  return { removable: true, reason: null };
}

export function createState({
  account = DEFAULT_ACCOUNT,
  assetCode = DEFAULT_ASSET_CODE,
  issuer = DEFAULT_ISSUER,
  balance = "0",
} = {}) {
  return {
    trustlines: [{ account, assetCode, issuer, balance: String(balance) }],
  };
}

export function handleRequest(
  method,
  url,
  body = {},
  state = createState(),
) {
  const path = new URL(url, "http://localhost").pathname;
  const identity = body ?? {};

  if (method === "POST" && path === "/add") {
    if (!validIdentity(identity)) {
      return response(400, { error: "account, assetCode, and issuer are required" }, state);
    }
    const nextTrustline = {
      account: identity.account,
      assetCode: identity.assetCode,
      issuer: identity.issuer,
      balance: String(identity.balance ?? "0"),
    };
    const existing = findTrustline(state, identity);
    const trustlines = existing
      ? state.trustlines.map((trustline) =>
          keyOf(trustline) === keyOf(identity) ? nextTrustline : trustline,
        )
      : [...state.trustlines, nextTrustline];
    const nextState = { ...state, trustlines };
    return response(200, { added: true, trustline: nextTrustline }, nextState);
  }

  if (method === "POST" && path === "/check-removable") {
    if (!validIdentity(identity)) {
      return response(400, { error: "account, assetCode, and issuer are required" }, state);
    }
    const trustline = findTrustline(state, identity);
    if (!trustline) {
      return response(404, { error: "trustline_not_found" }, state);
    }
    return response(200, removable(trustline), state);
  }

  if (method === "POST" && path === "/remove") {
    if (!validIdentity(identity)) {
      return response(400, { error: "account, assetCode, and issuer are required" }, state);
    }
    const trustline = findTrustline(state, identity);
    if (!trustline) {
      return response(404, { error: "trustline_not_found" }, state);
    }
    const eligibility = removable(trustline);
    if (!eligibility.removable) {
      return response(409, { ...eligibility, error: "trustline_not_removable" }, state);
    }
    const nextState = {
      ...state,
      trustlines: state.trustlines.filter(
        (candidate) => keyOf(candidate) !== keyOf(identity),
      ),
    };
    return response(200, { removed: true }, nextState);
  }

  return response(404, { error: "not_found" }, state);
}

function readJsonBody(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
  });
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entry !== null && import.meta.url === entry) {
  let state = createState();
  const server = http.createServer(async (request, reply) => {
    const body = await readJsonBody(request);
    const result = body === null
      ? response(400, { error: "invalid_json" }, state)
      : handleRequest(request.method, request.url, body, state);
    state = result.state;
    reply.writeHead(result.status, { "Content-Type": "application/json" });
    reply.end(JSON.stringify(result.body));
  });
  const port = process.env.PORT || 4110;
  server.listen(port, () => {
    console.log(`trustline-lifecycle-suite listening on http://localhost:${port}`);
  });
}
