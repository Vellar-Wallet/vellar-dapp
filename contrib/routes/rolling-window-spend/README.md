# Rolling Window Spend

A self-contained route module that tracks cumulative sample spend for an account within a rolling time window.

## Endpoints

- `GET /allowance/:accountId`
  - Returns the remaining allowance given a fixed limit and window length.
- `POST /spend/:accountId`
  - Body: `{ "amount": number }`
  - Accepts a spend amount and adds it to an in-memory running total. Fails if the limit is exceeded.

## Configuration

The limit is fixed at `1000` and the window is 60 seconds.

## Usage

```sh
node index.js
```

## Testing

Run the test script to see a scenario where the limit is exceeded:

```sh
node test.js
```
