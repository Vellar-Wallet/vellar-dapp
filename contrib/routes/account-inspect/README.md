# Account Inspect Route

Self contained mock route module for account inspection and blocker detection.

## Endpoints
- `GET /:accountId`: Returns a list of blockers for the given `accountId`.

## Usage
Mount this router in an express application:
```javascript
const express = require('express');
const accountInspectRoute = require('./contrib/routes/account-inspect');
const app = express();
app.use('/account-inspect', accountInspectRoute);
```

## Testing
Run the included test script:
```bash
node test.js
```
