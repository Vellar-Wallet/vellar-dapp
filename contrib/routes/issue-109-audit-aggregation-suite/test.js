const { spawn } = require('child_process');

const server = spawn('node', ['server.js'], { cwd: __dirname });

setTimeout(async () => {
  try {
    console.log('--- Summary Endpoint ---');
    let res = await fetch('http://localhost:3109/summary');
    console.log(`Body:`, await res.json());

    console.log('\n--- Entries: Combined Filter (actor=alice, action=transfer, page=1, limit=2) ---');
    res = await fetch('http://localhost:3109/entries?actor=alice&action=transfer&page=1&limit=2');
    console.log(`Body:`, await res.json());

    console.log('\n--- Entries: Pagination (page=2, limit=2) ---');
    res = await fetch('http://localhost:3109/entries?actor=alice&action=transfer&page=2&limit=2');
    console.log(`Body:`, await res.json());

  } catch (err) {
    console.error(err);
  } finally {
    server.kill();
  }
}, 1000);
