import { describe, it, expect, beforeEach } from 'vitest';
import supertest from 'supertest';
import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import { build, _clear } from '../index';

const app = new Koa();
const router = new Router();

app.use(bodyParser());
build(router);
app.use(router.routes()).use(router.allowedMethods());

const request = supertest(app.callback());

describe('Device Pairing Suite', () => {
  beforeEach(() => {
    _clear();
  });

  it('should complete the full device pairing and session lifecycle', async () => {
    // 1. Request pairing
    const requestRes = await request
      .post('/device-pairing-suite/request')
      .send({ deviceId: 'test-device-123' });

    expect(requestRes.status).toBe(201);
    expect(requestRes.body).toHaveProperty('pairingId');
    const { pairingId } = requestRes.body;

    // 2. Attempt to issue session before approval (should fail)
    const issueSessionFailRes = await request
      .post('/device-pairing-suite/issue-session')
      .send({ pairingId });
    
    expect(issueSessionFailRes.status).toBe(403);
    expect(issueSessionFailRes.body.error).toBe('Pairing not approved');

    // 3. Approve pairing
    const approveRes = await request
      .post('/device-pairing-suite/approve')
      .send({ pairingId });

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.message).toBe('Pairing approved');

    // 4. Issue session after approval
    const issueSessionRes = await request
      .post('/device-pairing-suite/issue-session')
      .send({ pairingId });

    expect(issueSessionRes.status).toBe(201);
    expect(issueSessionRes.body).toHaveProperty('sessionId');
    const { sessionId } = issueSessionRes.body;

    // 5. Check session status
    const statusRes1 = await request.get(`/device-pairing-suite/session-status/${sessionId}`);
    expect(statusRes1.status).toBe(200);
    expect(statusRes1.body.status).toBe('active');

    // 6. Revoke session
    const revokeRes = await request
      .post('/device-pairing-suite/revoke')
      .send({ sessionId });

    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.message).toBe('Session revoked');

    // 7. Check session status again
    const statusRes2 = await request.get(`/device-pairing-suite/session-status/${sessionId}`);
    expect(statusRes2.status).toBe(200);
    expect(statusRes2.body.status).toBe('revoked');
  });
});
