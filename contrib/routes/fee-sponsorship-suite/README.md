# Fee Sponsorship Suite

A standalone Node.js HTTP example that tracks a sponsor's in-memory fee budget across mock submissions. It uses only Node built-ins.

Run the test with `node --test server.test.js`. Start the server with `node server.js`; it listens on `127.0.0.1:3001` by default, or on the port in `PORT`.

## Endpoints

### `POST /submit`

Accepts an optional JSON body such as `{ "fee": 25 }`. Each accepted submission deducts the provided fee, or 40 units when omitted, and returns a submission ID and remaining balance. A fee must be a positive finite number. When the fee exceeds the remaining balance, the endpoint returns `409` with the clear error `Sponsor budget exhausted`; the balance is unchanged.

### `GET /sponsor-balance`

Returns the current in-memory budget as `{ "sponsorBalance": 20 }`. Each server instance starts with 100 units.
