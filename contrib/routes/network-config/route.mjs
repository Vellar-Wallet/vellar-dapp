import http from "node:http";

/**
 * Mock Route Module: Supported Network Configuration Lookup (Issue #89)
 *
 * Returns sample network configuration — rpc url, passphrase, horizon url —
 * for a named network like `testnet` or `mainnet`. Values mirror the canonical
 * Stellar endpoints so the shape matches what the real services consume, but
 * nothing here reaches the network: the table below is the whole data source.
 */

const NETWORKS = {
  testnet: {
    network: "testnet",
    label: "Stellar Testnet",
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    friendbotUrl: "https://friendbot.stellar.org",
    explorerUrl: "https://stellar.expert/explorer/testnet",
    isTestNetwork: true,
  },
  mainnet: {
    network: "mainnet",
    label: "Stellar Mainnet",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    rpcUrl: "https://mainnet.sorobanrpc.com",
    horizonUrl: "https://horizon.stellar.org",
    friendbotUrl: null,
    explorerUrl: "https://stellar.expert/explorer/public",
    isTestNetwork: false,
  },
};

/**
 * Alternate spellings callers reach for. Kept separate from NETWORKS so the
 * canonical list stays the thing `/networks` advertises.
 */
const ALIASES = {
  test: "testnet",
  future: "testnet",
  public: "mainnet",
  pubnet: "mainnet",
  main: "mainnet",
};

const SUPPORTED = Object.keys(NETWORKS);

/** Resolve a caller-supplied name to a canonical network id, or `null`. */
export function resolveNetworkName(name) {
  if (typeof name !== "string") return null;
  const key = name.trim().toLowerCase();
  if (!key) return null;
  if (Object.hasOwn(NETWORKS, key)) return key;
  if (Object.hasOwn(ALIASES, key)) return ALIASES[key];
  return null;
}

/** `GET /networks` — the canonical names this module can answer for. */
export function listNetworks() {
  return {
    status: 200,
    payload: {
      supported: SUPPORTED,
      networks: SUPPORTED.map((id) => ({
        network: id,
        label: NETWORKS[id].label,
        isTestNetwork: NETWORKS[id].isTestNetwork,
      })),
    },
  };
}

/** `GET /networks/:name` — the full sample configuration for one network. */
export function getNetworkConfig(name) {
  const resolved = resolveNetworkName(name);
  if (!resolved) {
    return {
      status: 404,
      payload: { error: "unsupported_network", requested: name ?? null, supported: SUPPORTED },
    };
  }

  // Copy so a caller mutating the response can't corrupt the table.
  return { status: 200, payload: { ...NETWORKS[resolved], requested: name } };
}

export function handleRequest(method, pathname) {
  const parts = pathname.split("/").filter(Boolean);

  if (method === "GET" && parts[0] === "networks" && parts.length === 1) {
    return listNetworks();
  }

  if (method === "GET" && parts[0] === "networks" && parts.length === 2) {
    return getNetworkConfig(decodeURIComponent(parts[1]));
  }

  return { status: 404, payload: { error: "not_found" } };
}

const PORT = process.env.PORT || 4089;
if (process.argv[1] && process.argv[1].endsWith("route.mjs")) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const { status, payload } = handleRequest(req.method, url.pathname);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });

  server.listen(PORT, () => {
    console.log(`network-config mock listening on http://localhost:${PORT}/networks`);
  });
}
