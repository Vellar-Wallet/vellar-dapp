const knownHashes = {
  '0x123': 'success',
  '0x456': 'pending'
};

module.exports = function pollStatuses(hashes) {
  if (!Array.isArray(hashes)) {
    throw new Error('Expected an array of hashes');
  }
  if (hashes.length > 20) {
    throw new Error('Limit of 20 hashes exceeded');
  }
  return hashes.reduce((acc, hash) => {
    acc[hash] = knownHashes[hash] || 'not_found';
    return acc;
  }, {});
};
