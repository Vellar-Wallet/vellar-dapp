# Verification Submission & Diff Simulation Suite

This directory contains a self-contained route suite that simulates the contract
verification submission and status-diffing flow, as requested in issue #94.

It runs a simple Express server to expose three endpoints:

- `POST /submit`: Accepts a mock contract submission.
- `GET /status/:contractId`: Reports the build status, transitioning from
  `building` to `complete`.
- `GET /diff/:contractId`: Compares the submitted details against a reference
  and reports any differences.

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

The server will start on `http://localhost:4500`.

## Testing the Flow

A test script, `test.js`, is included to demonstrate the full flow for both a
matching and a non-matching submission. It uses the built-in `fetch` from Node.js.

To run the test script, first ensure the server is running in another terminal,
then execute:

```sh
node test.js
```

You will see output detailing the submission, status polling, and final diff
result for both scenarios.

## Endpoints

### `POST /submit`

Accepts a JSON body with contract source details and initiates a mock build process.

### `GET /status/:contractId`

Returns the current status of a submission. On the first two requests for a given
`contractId`, it returns `{ "status": "building" }`. On the third and subsequent
requests, it returns `{ "status": "complete" }`.

### `GET /diff/:contractId`

Returns a diff report comparing the submitted details to a hardcoded reference
contract. The response includes a `match` boolean and a list of `diffs` if
there is a mismatch.