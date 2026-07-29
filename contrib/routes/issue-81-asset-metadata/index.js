const knownAssets = {
  'USDC_issuer123': { name: 'USD Coin', icon: 'https://example.com/usdc.png' },
  'BTC_issuer456': { name: 'Bitcoin', icon: 'https://example.com/btc.png' },
  'ETH_issuer789': { name: 'Ethereum', icon: 'https://example.com/eth.png' },
  'XLM_issuer000': { name: 'Stellar Lumens', icon: 'https://example.com/xlm.png' }
};

module.exports = function enrichAsset(code, issuer) {
  const key = `${code}_${issuer}`;
  const metadata = knownAssets[key];
  if (metadata) {
    return { code, issuer, ...metadata };
  }
  return { code, issuer, name: 'Unknown Asset', icon: 'https://example.com/placeholder.png' };
};
