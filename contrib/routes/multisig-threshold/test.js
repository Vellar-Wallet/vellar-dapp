const server = require('./index');
const http = require('http');

server.listen(0, async () => {
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;
  
  const request = (method, path, body) => new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });

  try {
    console.log('1. Get current config');
    let res = await request('GET', '/config');
    console.log('Response:', res);

    console.log('\n2. Set valid threshold (3)');
    res = await request('POST', '/config', { threshold: 3 });
    console.log('Response:', res);
    
    console.log('\n3. Set invalid threshold (4) - exceeds signers');
    res = await request('POST', '/config', { threshold: 4 });
    console.log('Response:', res);
    
    console.log('\n4. Get updated config');
    res = await request('GET', '/config');
    console.log('Response:', res);

  } catch (err) {
    console.error(err);
  } finally {
    server.close();
  }
});
