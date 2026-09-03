const { spawn } = require('child_process');

const server = spawn('node', ['server.js'], { cwd: __dirname });

setTimeout(async () => {
  try {
    console.log('--- List Types ---');
    let res = await fetch('http://localhost:3101/list-types');
    console.log(`Body:`, await res.json());

    console.log('\n--- Get Rules (spending_limit) ---');
    res = await fetch('http://localhost:3101/get-rules?type=spending_limit');
    console.log(`Body:`, await res.json());

    console.log('\n--- Validate: Passing Config ---');
    res = await fetch('http://localhost:3101/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'spending_limit', config: { amount: 100 } })
    });
    console.log(`Body:`, await res.json());

    console.log('\n--- Validate: Failing Config ---');
    res = await fetch('http://localhost:3101/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'spending_limit', config: { amount: 5 } })
    });
    console.log(`Body:`, await res.json());

  } catch (err) {
    console.error(err);
  } finally {
    server.kill();
  }
}, 1000);
