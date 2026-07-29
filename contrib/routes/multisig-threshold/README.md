# Multisig Threshold

A self-contained route module with endpoints to set a multisig threshold for a sample account and to read the current configuration.

## Endpoints

- `GET /config`
  - Returns the current threshold and the signer count.
- `POST /config`
  - Body: `{ "threshold": number }`
  - Sets a new threshold. Validates that the threshold does not exceed the number of signers.

## Usage

```sh
node index.js
```

## Testing

Run the test script covering a valid set and an invalid over threshold set:

```sh
node test.js
```
