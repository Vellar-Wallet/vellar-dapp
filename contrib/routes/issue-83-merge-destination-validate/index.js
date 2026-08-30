module.exports = function validateMerge(source, destination) {
  if (source === destination) {
    return { valid: false, reason: 'Destination cannot match source account id' };
  }
  return { valid: true, reason: '' };
};
