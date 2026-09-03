const assert = require('assert');
const { registerPasskeyEndpoint } = require('./index');

function runTest() {
  const credentialId = 'cred_fake_12345';
  const publicKey = 'pub_key_abcde';
  
  console.log('1. First registration attempt...');
  const res1 = registerPasskeyEndpoint({ credentialId, publicKey });
  console.log('Response 1:', res1);
  
  console.log('\n2. Second registration attempt with the same credentialId...');
  const res2 = registerPasskeyEndpoint({ credentialId, publicKey });
  console.log('Response 2:', res2);
  
  try {
    assert.strictEqual(res1.data.walletId, res2.data.walletId, 'walletIds should match');
    console.log('\nSuccess: Both requests returned the same walletId:', res1.data.walletId);
  } catch (error) {
    console.error('\nFailure:', error.message);
    process.exit(1);
  }
}

runTest();
