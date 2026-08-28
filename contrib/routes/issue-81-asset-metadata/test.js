const enrich = require('./index');

console.log('Known asset:', enrich('USDC', 'issuer123'));
console.log('Unknown asset:', enrich('UNKNOWN', 'issuer999'));
