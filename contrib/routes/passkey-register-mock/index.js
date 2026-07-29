const crypto = require('crypto');

/**
 * Mock route module for simulating a passkey registration response
 */

/**
 * Register endpoint
 * Accepts a fake credential id and public key string.
 * Returns a deterministic walletId derived from the credential id.
 */
function registerPasskeyEndpoint(req) {
  const { credentialId, publicKey } = req;
  
  if (!credentialId || !publicKey) {
    return { status: 400, data: { error: 'credentialId and publicKey are required' } };
  }
  
  // Deterministically derive a walletId using a hash of the credentialId
  const hash = crypto.createHash('sha256').update(credentialId).digest('hex');
  const walletId = `wallet_${hash.substring(0, 16)}`;
  
  return { 
    status: 200, 
    data: { 
      walletId,
      message: 'Passkey registration successful' 
    } 
  };
}

module.exports = {
  registerPasskeyEndpoint
};
