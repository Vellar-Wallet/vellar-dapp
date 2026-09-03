# Issue #100 - Session Budget Suite

This suite simulates session key budget enforcement for an agent.

## Endpoints

### `GET /remaining-budget`
Returns the current remaining budget.

### `POST /spend`
Attempts to apply a spend against the remaining budget.

**Body:**
```json
{
  "amount": 100
}
```

**Responses:**
- **200 OK**: If the spend is within the remaining budget. The budget is decremented.
- **403 Forbidden**: If the spend exceeds the remaining budget. The budget is left unchanged.

## Running the Test
Execute `node test.js` to run a simulation of successful spends and a rejected over-budget spend.
