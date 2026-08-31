const { spawn } = require('child_process');

const server = spawn('node', ['server.js'], { cwd: __dirname });

setTimeout(async () => {
  try {
    console.log('--- Initial Budget ---');
    let res = await fetch('http://localhost:3100/remaining-budget');
    console.log(`Body:`, await res.json());

    console.log('\n--- Spend 400 (Within Budget) ---');
    res = await fetch('http://localhost:3100/spend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 400 })
    });
    console.log(`Status: ${res.status}`);
    console.log(`Body:`, await res.json());

    console.log('\n--- Spend 500 (Within Budget) ---');
    res = await fetch('http://localhost:3100/spend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 500 })
    });
    console.log(`Status: ${res.status}`);
    console.log(`Body:`, await res.json());

    console.log('\n--- Spend 200 (Over Budget) ---');
    res = await fetch('http://localhost:3100/spend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 200 })
    });
    console.log(`Status: ${res.status}`);
    console.log(`Body:`, await res.json());

    console.log('\n--- Final Budget ---');
    res = await fetch('http://localhost:3100/remaining-budget');
    console.log(`Body:`, await res.json());

  } catch (err) {
    console.error(err);
  } finally {
    server.kill();
  }
}, 1000);
