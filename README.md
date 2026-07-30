# Device Pairing & Session Issuance Simulation Suite

This directory contains a self-contained route suite that simulates a device
pairing, session issuance, and revocation flow, as requested in issue #97.

It runs a simple Express server to expose five endpoints that model the
complete lifecycle of a device session.

## Running the Simulation

This suite requires `express` and `body-parser`. First, install the
dependencies from within this directory:

```sh
pnpm install express body-parser
```

Then, start the server:

```sh
node server.js
```

The server will start on `http://localhost:4501`.

## Testing the Flow

A test script, `test.js`, is included to demonstrate the full sequence from
requesting pairing to verifying revocation. It uses the built-in `fetch` from
Node.js.

To run the test script, first ensure the server is running in another terminal,
then execute:

```sh
node test.js
```

You will see detailed output for each step of the flow, confirming that the
logic for approval and revocation is working correctly.

## Endpoints

### `POST /request-pairing`

A device initiates a pairing request by submitting its `publicKey`. The server
returns a unique `deviceId` for tracking.

**Body:** `{ "publicKey": "string" }`

### `POST /approve-pairing/:deviceId`

A user approves a pending pairing request for a given `deviceId`. This action is
a prerequisite for issuing a session.

### `POST /issue-session`

The approved device requests a session token by presenting its `deviceId` and
`publicKey`. This endpoint will fail if the pairing has not been approved. On
success, it returns a `sessionId`.

**Body:** `{ "deviceId": "string", "publicKey": "string" }`

### `GET /session-status/:sessionId`

Checks the current status of a given `sessionId`. The status will be `active` or
`revoked`.

### `POST /revoke-session`

Invalidates a session, changing its status to `revoked`.

**Body:** `{ "sessionId": "string" }`