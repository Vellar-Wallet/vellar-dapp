# Spending Policy CRUD Route

Self contained mock route module for creating and listing spending policies.

## Endpoints
- `POST /policies`: Creates a new spending policy. Requires `limit` and `windowSeconds` (must be positive numbers) in the request body.
- `GET /policies`: Lists all policies created in the current process memory.

## Usage
Mount this router in an express application:
```javascript
const express = require('express');
const spendingPolicyCrudRoute = require('./contrib/routes/spending-policy-crud');
const app = express();
app.use('/spending-policy-crud', spendingPolicyCrudRoute);
```

## Testing
Run the included test script:
```bash
node test.js
```
