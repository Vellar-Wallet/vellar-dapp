const { addEndpoint, removeEndpoint } = require('./index');

function runTest() {
  const account = 'test-account';
  const assetCode = 'USDC';
  const issuer = 'GABC123';
  
  console.log('1. Testing add endpoint');
  const addRes = addEndpoint({ account, assetCode, issuer });
  console.log('Add response:', addRes);
  
  console.log('\n2. Testing remove endpoint');
  const removeRes = removeEndpoint({ account, assetCode, issuer });
  console.log('Remove response:', removeRes);
  
  console.log('\n3. Testing repeat remove endpoint (should return 404)');
  const repeatRemoveRes = removeEndpoint({ account, assetCode, issuer });
  console.log('Repeat remove response:', repeatRemoveRes);
}

runTest();
