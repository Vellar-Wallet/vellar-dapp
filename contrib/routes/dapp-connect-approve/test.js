const { requestConnectionEndpoint, approveConnectionEndpoint } = require('./index');

function runTest() {
  console.log('--- Testing Approve Sequence ---');
  let reqRes = requestConnectionEndpoint({ origin: 'https://example-dapp.com' });
  console.log('Request response:', reqRes);
  
  let connId = reqRes.data.connectionId;
  
  let approveRes = approveConnectionEndpoint({ connectionId: connId, decision: 'approve' });
  console.log('Approve response:', approveRes);
  
  console.log('\n--- Testing Deny Sequence ---');
  reqRes = requestConnectionEndpoint({ origin: 'https://malicious-dapp.com' });
  console.log('Request response:', reqRes);
  
  connId = reqRes.data.connectionId;
  
  let denyRes = approveConnectionEndpoint({ connectionId: connId, decision: 'deny' });
  console.log('Deny response:', denyRes);
}

runTest();
