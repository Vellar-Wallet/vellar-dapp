# Permission Grant and Revoke Route

Self contained mock route module for origin permission grant and revoke.

## Endpoints
- `POST /grant`: Grants an origin permission. Requires `origin` in the request body. Stores the origin and a `grantedAt` timestamp in memory.
- `POST /revoke`: Revokes a previously granted origin. Requires `origin` in the request body. Returns a 404 error if the origin has no active grant.

## Usage
Mount this router in an express application:
```javascript
const express = require('express');
const permissionGrantRevokeRoute = require('./contrib/routes/permission-grant-revoke');
const app = express();
app.use('/permission-grant-revoke', permissionGrantRevokeRoute);
```

## Testing
Run the included test script:
```bash
node test.js
```
