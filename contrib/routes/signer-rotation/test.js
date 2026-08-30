const { requestRotationEndpoint, checkStatusEndpoint } = require('./index');

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTest() {
  console.log('1. Requesting signer rotation...');
  const reqRes = requestRotationEndpoint({ account: 'acc123', newSignerKey: 'pubkey456' });
  console.log('Request response:', reqRes);
  
  const { rotationId } = reqRes.data;
  
  if (!rotationId) {
    console.error('Failed to get rotationId');
    return;
  }
  
  console.log('\n2. Polling for status...');
  let currentStatus = reqRes.data.status;
  let attempts = 0;
  
  while (currentStatus === 'pending' && attempts < 10) {
    attempts++;
    console.log(`Poll attempt ${attempts}...`);
    const statusRes = checkStatusEndpoint({ rotationId });
    console.log('Status response:', statusRes);
    
    currentStatus = statusRes.data.status;
    
    if (currentStatus === 'pending') {
       await delay(500);
    }
  }
  
  if (currentStatus === 'completed') {
    console.log('\nSuccess: Rotation completed!');
  } else {
    console.log('\nFailure: Rotation did not complete.');
  }
}

runTest();
