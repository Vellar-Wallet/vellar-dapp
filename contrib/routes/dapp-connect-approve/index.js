const crypto = require('crypto');

/**
 * Mock route module simulating a dApp connection approval flow
 */

// In-memory store: connectionId -> { origin: string, status: 'pending' | 'approved' | 'denied' }
const connections = new Map();

/**
 * Request endpoint
 * Allows a dApp to request a connection. Returns a pending connectionId tied to an origin.
 */
function requestConnectionEndpoint(req) {
  const { origin } = req;
  
  if (!origin) {
    return { status: 400, data: { error: 'origin is required' } };
  }
  
  const connectionId = `conn_${crypto.randomBytes(8).toString('hex')}`;
  
  connections.set(connectionId, {
    origin,
    status: 'pending'
  });
  
  return { 
    status: 200, 
    data: { 
      connectionId,
      status: 'pending',
      message: 'Connection requested' 
    } 
  };
}

/**
 * Approve endpoint
 * Accepts the connectionId and a decision of 'approve' or 'deny'.
 */
function approveConnectionEndpoint(req) {
  const { connectionId, decision } = req;
  
  if (!connectionId || !decision) {
    return { status: 400, data: { error: 'connectionId and decision are required' } };
  }
  
  if (decision !== 'approve' && decision !== 'deny') {
    return { status: 400, data: { error: 'decision must be approve or deny' } };
  }
  
  const connection = connections.get(connectionId);
  
  if (!connection) {
    return { status: 404, data: { error: 'Connection not found' } };
  }
  
  if (connection.status !== 'pending') {
    return { status: 400, data: { error: `Connection is already ${connection.status}` } };
  }
  
  connection.status = decision === 'approve' ? 'approved' : 'denied';
  
  return { 
    status: 200, 
    data: { 
      connectionId,
      origin: connection.origin,
      status: connection.status,
      message: `Connection ${connection.status}` 
    } 
  };
}

module.exports = {
  requestConnectionEndpoint,
  approveConnectionEndpoint
};
