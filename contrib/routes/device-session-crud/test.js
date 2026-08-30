const express = require('express');
const route = require('./index');
const http = require('http');

const app = express();
app.use('/', route);
const server = http.createServer(app);

server.listen(0, async () => {
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;
  
  console.log('Listing sessions initially:');
  const res1 = await fetch(`${baseUrl}/sessions`);
  console.log(await res1.json());
  
  console.log('\nRevoking session_2:');
  const res2 = await fetch(`${baseUrl}/sessions/session_2/revoke`, {
    method: 'POST'
  });
  console.log('Revoke response status:', res2.status);
  console.log(await res2.json());
  
  console.log('\nListing sessions after revocation:');
  const res3 = await fetch(`${baseUrl}/sessions`);
  console.log(await res3.json());
  
  server.close();
});
