// Mock GET route returning a fixed list of signers for a smart account. No
// chain or DB access.
import http from "node:http";
import { pathToFileURL } from "node:url";

const KEY_TYPES = ["ed25519", "secp256r1"];

const MOCK_SIGNERS = [
  {
    id: "sig_001",
    label: "Primary device",
    keyType: "ed25519",
    publicKey: "GCKFBEIYV2V5BVZ6Q7V7QV7QV7QV7QV7QV7QV7QV7QV7QV7QV7",
    weight: 10,
    addedAt: "2026-01-14T09:20:00.000Z",
  },
  {
    id: "sig_002",
    label: "Passkey (browser)",
    keyType: "secp256r1",
    publicKey: "PBKDF1234567890ABCDEF1234567890ABCDEF1234567890ABCD",
    weight: 5,
    addedAt: "2026-02-02T17:45:00.000Z",
  },
  {
    id: "sig_003",
    label: "Passkey (mobile)",
    keyType: "secp256r1",
    publicKey: "PBKD0987654321FEDCBA0987654321FEDCBA0987654321FEDC",
    weight: 5,
    addedAt: "2026-03-11T11:05:00.000Z",
  },
  {
    id: "sig_004",
    label: "Recovery key",
    keyType: "ed25519",
    publicKey: "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB",
    weight: 1,
    addedAt: "2026-03-28T08:00:00.000Z",
  },
];

export { KEY_TYPES, MOCK_SIGNERS };

export function handleRequest() {
  return {
    status: 200,
    body: {
      accountId: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
      signers: MOCK_SIGNERS,
      threshold: 10,
    },
  };
}

// pathToFileURL keeps the entrypoint check correct on Windows and with
// relative argv paths, where a raw `file://` + argv[1] concatenation never
// matches import.meta.url.
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/signer-list") {
      const { status, body } = handleRequest();
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4044;
  server.listen(port, () => {
    console.log(`signer-list mock listening on http://localhost:${port}/signer-list`);
  });
}
