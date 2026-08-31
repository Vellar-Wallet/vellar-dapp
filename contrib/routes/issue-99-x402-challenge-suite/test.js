const { spawn } = require('child_process');

const server = spawn('node', ['server.js'], { cwd: __dirname });

setTimeout(async () => {
  try {
    console.log('--- Initial Request (No Proof) ---');
    const res1 = await fetch('http://localhost:3099/protected');
    console.log(`Status: ${res1.status}`);
    console.log(`Body:`, await res1.json());

    console.log('\n--- Retry Request (Invalid Proof) ---');
    const res2 = await fetch('http://localhost:3099/protected', {
      headers: { 'x-payment-proof': 'invalid_proof' }
    });
    console.log(`Status: ${res2.status}`);
    console.log(`Body:`, await res2.json());

    console.log('\n--- Retry Request (Valid Proof) ---');
    const res3 = await fetch('http://localhost:3099/protected', {
      headers: { 'x-payment-proof': 'valid_mock_proof_123' }
    });
    console.log(`Status: ${res3.status}`);
    console.log(`Body:`, await res3.json());
  } catch (err) {
    console.error(err);
  } finally {
    server.kill();
  }
}, 1000);
