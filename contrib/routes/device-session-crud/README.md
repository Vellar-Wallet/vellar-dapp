# Device Session CRUD Route

Self contained mock route module for device session list and revoke.

## Endpoints
- `GET /sessions`: Lists all active mock device sessions.
- `POST /sessions/:id/revoke`: Revokes a session by `id`, removing it from the in-memory list.

## Usage
Mount this router in an express application:
```javascript
const express = require('express');
const deviceSessionCrudRoute = require('./contrib/routes/device-session-crud');
const app = express();
app.use('/device-session-crud', deviceSessionCrudRoute);
```

## Testing
Run the included test script:
```bash
node test.js
```
