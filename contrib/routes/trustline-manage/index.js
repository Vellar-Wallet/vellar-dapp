/**
 * Mock route module for trustline management
 */

// In-memory store: account -> Set of 'assetCode:issuer'
const trustlines = new Map();

/**
 * Add endpoint
 * Validates that asset code and issuer are present.
 */
function addEndpoint(req) {
  const { account, assetCode, issuer } = req;
  
  if (!account) {
    return { status: 400, data: { error: 'account is required' } };
  }
  if (!assetCode || !issuer) {
    return { status: 400, data: { error: 'assetCode and issuer are required' } };
  }
  
  const key = `${assetCode}:${issuer}`;
  if (!trustlines.has(account)) {
    trustlines.set(account, new Set());
  }
  
  trustlines.get(account).add(key);
  
  return { status: 200, data: { message: 'Trustline added' } };
}

/**
 * Remove endpoint
 * Returns a 404 style payload if the trustline does not exist.
 */
function removeEndpoint(req) {
  const { account, assetCode, issuer } = req;
  
  if (!account) {
    return { status: 400, data: { error: 'account is required' } };
  }
  if (!assetCode || !issuer) {
    return { status: 400, data: { error: 'assetCode and issuer are required' } };
  }
  
  const key = `${assetCode}:${issuer}`;
  const accountTrustlines = trustlines.get(account);
  
  if (!accountTrustlines || !accountTrustlines.has(key)) {
    return { status: 404, data: { error: 'Trustline not found' } };
  }
  
  accountTrustlines.delete(key);
  return { status: 200, data: { message: 'Trustline removed' } };
}

module.exports = {
  addEndpoint,
  removeEndpoint
};
