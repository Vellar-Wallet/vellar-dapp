// Mock GET route returning a paginated list of sample assets. No chain or DB access.
import http from "node:http";
import { URL } from "node:url";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 10;

const ASSETS = [
  { code: "XLM", issuer: "native", balance: "10000.0000000" },
  {
    code: "USDC",
    issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    balance: "2500.5000000",
  },
  {
    code: "AQUA",
    issuer: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA",
    balance: "50000.0000000",
  },
  {
    code: "yXLM",
    issuer: "GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PIGZC2JCLQFXWKW",
    balance: "875.2500000",
  },
  {
    code: "BTC",
    issuer: "GDPJALI4AZKUU2W426U5WKMAT6CN3AJRPIIRYQV7WHB2Z3RNBH3AVR2X",
    balance: "0.1500000",
  },
  {
    code: "ETH",
    issuer: "GBFXOHVAS43OIWNJDFTNY6L3JETQXHVXNXXTHIYWZR4EWZURPMU7Z9M2",
    balance: "3.2000000",
  },
  {
    code: "SHX",
    issuer: "GDSTRSHXHGJ7ZIVRBXEYE5Q74XUVCUSEKEBR7UCHEUUJK6PPZOD4KEUY",
    balance: "12000.0000000",
  },
  {
    code: "USDT",
    issuer: "GCQTGZQQ5G4PTM2GL7CDIFKUBIPEC52BROAQIAPW53XBRJVN6ZJVTG6V",
    balance: "999.9900000",
  },
  {
    code: "MOBI",
    issuer: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH",
    balance: "42.0000000",
  },
  {
    code: "RIO",
    issuer: "GCFVEHW5VXTQCLXIN2CGKGMKZOUQOMOQ5PL22F5C6HG5CY73GYYZ6RIO",
    balance: "1500.0000000",
  },
  {
    code: "SLT",
    issuer: "GCKA6K5PCQ6PNF5RQBF7PQDJWRHOKUJT5IWEG7NRZDGCQNK7PGYQHYCE",
    balance: "300.7500000",
  },
  {
    code: "VELO",
    issuer: "GDM4RQUQQUVSKQA7S6EM7XBZP3FCGH4Q7CL6TABQ7B2BEJ5ERASQXVEL",
    balance: "60.1000000",
  },
];

function parsePositiveInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

export function handleRequest({ query = {} } = {}) {
  const page = parsePositiveInt(query.page, DEFAULT_PAGE);
  const pageSize = parsePositiveInt(query.pageSize, DEFAULT_PAGE_SIZE);
  const start = (page - 1) * pageSize;
  const items = ASSETS.slice(start, start + pageSize);

  return {
    status: 200,
    body: {
      items,
      total: ASSETS.length,
      page,
      pageSize,
    },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/assets") {
      const query = Object.fromEntries(url.searchParams);
      const { status, body } = handleRequest({ query });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  const port = process.env.PORT || 4030;
  server.listen(port, () => {
    console.log(`asset-list mock listening on http://localhost:${port}/assets?page=&pageSize=`);
  });
}
