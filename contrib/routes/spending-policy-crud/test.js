const express = require('express');
const route = require('./index');
const http = require('http');

const app = express();
app.use('/', route);
const server = http.createServer(app);

server.listen(0, async () => {
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;
  
  console.log('Creating policy 1:');
  const res1 = await fetch(`${baseUrl}/policies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 100, windowSeconds: 3600 })
  });
  console.log(await res1.json());
  
  console.log('\nCreating policy 2:');
  const res2 = await fetch(`${baseUrl}/policies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 50, windowSeconds: 1800 })
  });
  console.log(await res2.json());
  
  console.log('\nListing all policies:');
  const res3 = await fetch(`${baseUrl}/policies`);
  console.log(await res3.json());
  
  server.close();
});
