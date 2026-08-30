/**
 * Mock route module for signer key rotation
 */

// In-memory store: rotationId -> { status: string, pollCount: number }
const rotations = new Map();
const MAX_POLLS = 3;

/**
 * Request endpoint
 * Starts a new signer key rotation request
 */
function requestRotationEndpoint(req) {
  const { account, newSignerKey } = req;
  
  if (!account || !newSignerKey) {
    return { status: 400, data: { error: 'account and newSignerKey are required' } };
  }
  
  const rotationId = `rot_${Math.random().toString(36).substr(2, 9)}`;
  
  rotations.set(rotationId, {
    status: 'pending',
    pollCount: 0
  });
  
  return { 
    status: 200, 
    data: { 
      rotationId, 
      status: 'pending',
      message: 'Signer rotation requested' 
    } 
  };
}

/**
 * Status endpoint
 * Checks the status of a rotation request.
 * Transitions to 'completed' after being polled a fixed number of times.
 */
function checkStatusEndpoint(req) {
  const { rotationId } = req;
  
  if (!rotationId) {
    return { status: 400, data: { error: 'rotationId is required' } };
  }
  
  const rotation = rotations.get(rotationId);
  
  if (!rotation) {
    return { status: 404, data: { error: 'Rotation request not found' } };
  }
  
  // Transition logic
  if (rotation.status === 'pending') {
    rotation.pollCount += 1;
    if (rotation.pollCount >= MAX_POLLS) {
      rotation.status = 'completed';
    }
  }
  
  return { 
    status: 200, 
    data: { 
      rotationId, 
      status: rotation.status 
    } 
  };
}

module.exports = {
  requestRotationEndpoint,
  checkStatusEndpoint
};
