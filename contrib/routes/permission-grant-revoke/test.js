const express = require('express');
const route = require('./index');
const http = require('http');

const app = express();
app.use('/', route);
const server = http.createServer(app);

server.listen(0, async () => {
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;
  
  console.log('Granting origin: https://example.com');
  const res1 = await fetch(`${baseUrl}/grant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ origin: 'https://example.com' })
  });
  console.log('Grant response status:', res1.status);
  console.log(await res1.json());
  
  console.log('\nRevoking origin: https://example.com');
  const res2 = await fetch(`${baseUrl}/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ origin: 'https://example.com' })
  });
  console.log('Revoke response status:', res2.status);
  console.log(await res2.json());
  
  console.log('\nRevoking again: https://example.com');
  const res3 = await fetch(`${baseUrl}/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ origin: 'https://example.com' })
  });
  console.log('Repeat revoke response status:', res3.status);
  console.log(await res3.json());
  
  server.close();
});
