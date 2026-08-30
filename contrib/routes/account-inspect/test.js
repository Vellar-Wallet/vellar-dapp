const express = require('express');
const route = require('./index');
const http = require('http');

const app = express();
app.use('/inspect', route);
const server = http.createServer(app);

server.listen(0, async () => {
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}/inspect`;
  
  console.log('Testing account with blockers (account_1):');
  const res1 = await fetch(`${baseUrl}/account_1`);
  console.log(await res1.json());
  
  console.log('\nTesting account with no blockers (account_clear):');
  const res2 = await fetch(`${baseUrl}/account_clear`);
  console.log(await res2.json());
  
  server.close();
});
