# Mock route: blocked transaction explainer suite (Issue #10 — B10)

Simulates the UI behaviour when a transaction is blocked because the target
contract is not verified. Exposes endpoints to check verification status,
retrieve the honest explainer copy, and simulate acknowledgement of a warn
behaviour.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/explainer/blocked` | Returns the blocked-transaction explainer copy (honest wording, no "safe" claims). |
| POST | `/explainer/check` | Given a target contract, returns whether the transaction is allowed or blocked. |
| POST | `/explainer/acknowledge` | Records that the user acknowledged a warn-state. |

## Run

```sh
node route.mjs
# blocked-explainer mock listening on http://localhost:4010
```

## Test

```sh
node route.test.mjs
```

## Example — blocked (unverified contract)

```
POST /explainer/check
{ "targetContract": "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67", "policyAttached": true }
```

```json
{
  "allowed": false,
  "reason": "contract_not_verified",
  "explainer": {
    "title": "Transaction blocked",
    "body": "The target contract's source has not been verified...",
    "action": "You can inspect the contract on the verification explorer...",
    "explorerUrl": "/verify?contract=CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67"
  }
}
```

## Example — allowed (verified contract)

```
POST /explainer/check
{ "targetContract": "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67", "policyAttached": true, "verifiedContracts": ["CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67"] }
```

```json
{ "allowed": true, "reason": null }
```
