# Payment Lifecycle Suite

A self-contained set of route handlers that track a mock payment through its lifecycle.

## Endpoints

- `POST /build`
  - Creates a new payment.
- `POST /review/:id`
  - Transitions a payment to reviewed status.
- `POST /submit/:id`
  - Submits a payment and sets status to pending.
- `GET /status/:id`
  - Gets the status of a payment.
  - Automatically transitions a `pending` payment to `settled` after 3 status checks.

## Usage

```sh
node index.js
```

## Testing

Run the provided test script to walk through the sequence:

```sh
node test.js
```
