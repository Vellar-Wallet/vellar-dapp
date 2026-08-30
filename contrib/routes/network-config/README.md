# Mock route module: supported network configuration lookup (Issue #89)

Self contained route module that returns sample network configuration — rpc
url, network passphrase, horizon url — for a named network like `testnet` or
`mainnet`.

Nothing here reaches the network. The configuration table inside `route.mjs` is
the whole data source; the values mirror the canonical Stellar endpoints so the
response shape matches what the real services consume.

## Endpoints

### `GET /networks`

Lists the canonical network names this module can answer for. Aliases are
accepted on lookup but deliberately not advertised here.

```json
{
  "supported": ["testnet", "mainnet"],
  "networks": [
    { "network": "testnet", "label": "Stellar Testnet", "isTestNetwork": true },
    { "network": "mainnet", "label": "Stellar Mainnet", "isTestNetwork": false }
  ]
}
```

### `GET /networks/:name`

Returns the full sample configuration for one network.

```json
{
  "network": "testnet",
  "label": "Stellar Testnet",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "rpcUrl": "https://soroban-testnet.stellar.org",
  "horizonUrl": "https://horizon-testnet.stellar.org",
  "friendbotUrl": "https://friendbot.stellar.org",
  "explorerUrl": "https://stellar.expert/explorer/testnet",
  "isTestNetwork": true,
  "requested": "testnet"
}
```

`requested` echoes the caller's spelling, so an alias lookup still shows what
was asked for alongside the resolved `network`.

An unknown name responds `404` with the supported list, rather than falling
back to a default network:

```json
{
  "error": "unsupported_network",
  "requested": "regtest",
  "supported": ["testnet", "mainnet"]
}
```

## Name resolution

Lookups are case insensitive and tolerate surrounding whitespace, so
`" TESTNET "` resolves to `testnet`. These aliases also resolve:

| Alias              | Resolves to |
| ------------------ | ----------- |
| `test`, `future`   | `testnet`   |
| `public`, `pubnet` | `mainnet`   |
| `main`             | `mainnet`   |

`mainnet` has no friendbot, so its `friendbotUrl` is `null` rather than omitted
— a caller can tell "no faucet on this network" from "field missing".

## Run

```sh
node route.mjs
# network-config mock listening on http://localhost:4089/networks
```

## Testing

Covers both networks, alias and case-insensitive resolution, unknown-name
rejection, and that a mutated response cannot corrupt the table for the next
caller:

```sh
node route.test.mjs
```
