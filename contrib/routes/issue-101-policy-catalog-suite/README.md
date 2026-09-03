# Issue #101 - Policy Catalog Suite

This suite simulates a policy catalog with validation rules.

## Endpoints

### `GET /list-types`
Returns a list of available policy types.

### `GET /get-rules?type={type}`
Returns the validation rules for a specific policy type.

### `POST /validate`
Validates a candidate configuration against a specific policy type.

**Body:**
```json
{
  "type": "spending_limit",
  "config": {
    "amount": 100
  }
}
```

**Responses:**
- **200 OK**: Returns a JSON object with a `valid` boolean and a `results` array detailing which rules passed or failed.

## Running the Test
Execute `node test.js` to see passing and failing validations.
