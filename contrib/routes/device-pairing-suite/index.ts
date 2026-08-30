import crypto from 'crypto';
import type { Context } from 'koa';
import type Router from '@koa/router';

interface PairingRequest {
  deviceId: string;
  status: 'pending' | 'approved';
  pairingId: string;
}

interface Session {
  sessionId: string;
  pairingId: string;
  status: 'active' | 'revoked';
}

const pairingRequests = new Map<string, PairingRequest>();
const sessions = new Map<string, Session>();

// --- Direct-callable functions for testing ---

export function requestPairing(deviceId: string): { pairingId: string } {
  if (!deviceId) {
    throw new Error('deviceId is required');
  }
  const pairingId = crypto.randomBytes(16).toString('hex');
  const pairingRequest: PairingRequest = {
    deviceId,
    pairingId,
    status: 'pending',
  };
  pairingRequests.set(pairingId, pairingRequest);
  return { pairingId };
}

export function approvePairing(pairingId: string): { message: string } {
  if (!pairingId) {
    throw new Error('pairingId is required');
  }
  const pairingRequest = pairingRequests.get(pairingId);
  if (!pairingRequest) {
    throw new Error('Pairing request not found');
  }
  pairingRequest.status = 'approved';
  return { message: 'Pairing approved' };
}

export function issueSession(pairingId: string): { sessionId: string } {
  if (!pairingId) {
    throw new Error('pairingId is required');
  }
  const pairingRequest = pairingRequests.get(pairingId);
  if (!pairingRequest) {
    throw new Error('Pairing request not found');
  }
  if (pairingRequest.status !== 'approved') {
    throw new Error('Pairing not approved');
  }
  const sessionId = crypto.randomBytes(16).toString('hex');
  const session: Session = {
    sessionId,
    pairingId,
    status: 'active',
  };
  sessions.set(sessionId, session);
  return { sessionId };
}

export function revokeSession(sessionId: string): { message: string } {
  if (!sessionId) {
    throw new Error('sessionId is required');
  }
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  session.status = 'revoked';
  return { message: 'Session revoked' };
}

export function getSessionStatus(sessionId: string): { status: 'active' | 'revoked' } {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  return { status: session.status };
}


// --- Koa Router for HTTP endpoints ---

export function build(router: Router) {
  router.post('/device-pairing-suite/request', (ctx: Context) => {
    try {
      const { deviceId } = ctx.request.body as { deviceId: string };
      ctx.body = requestPairing(deviceId);
      ctx.status = 201;
    } catch (e: any) {
      ctx.status = 400;
      ctx.body = { error: e.message };
    }
  });

  router.post('/device-pairing-suite/approve', (ctx: Context) => {
    try {
      const { pairingId } = ctx.request.body as { pairingId: string };
      ctx.body = approvePairing(pairingId);
    } catch (e: any) {
      ctx.status = e.message === 'Pairing request not found' ? 404 : 400;
      ctx.body = { error: e.message };
    }
  });

  router.post('/device-pairing-suite/issue-session', (ctx: Context) => {
    try {
      const { pairingId } = ctx.request.body as { pairingId: string };
      ctx.body = issueSession(pairingId);
      ctx.status = 201;
    } catch (e: any) {
      if (e.message === 'Pairing request not found') {
        ctx.status = 404;
      } else if (e.message === 'Pairing not approved') {
        ctx.status = 403;
      } else {
        ctx.status = 400;
      }
      ctx.body = { error: e.message };
    }
  });

  router.post('/device-pairing-suite/revoke', (ctx: Context) => {
    try {
      const { sessionId } = ctx.request.body as { sessionId: string };
      ctx.body = revokeSession(sessionId);
    } catch (e: any) {
      ctx.status = e.message === 'Session not found' ? 404 : 400;
      ctx.body = { error: e.message };
    }
  });

  router.get('/device-pairing-suite/session-status/:sessionId', (ctx: Context) => {
    try {
      const { sessionId } = ctx.params;
      ctx.body = getSessionStatus(sessionId);
    } catch (e: any) {
      ctx.status = e.message === 'Session not found' ? 404 : 400;
      ctx.body = { error: e.message };
    }
  });
}

// For clearing state between tests
export function _clear() {
  pairingRequests.clear();
  sessions.clear();
}
