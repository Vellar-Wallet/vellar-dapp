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
    console.log('1. Lookup known contract');
    let res = await request('GET', '/lookup/contract-1');
    console.log('Response:', res);

    console.log('\n2. Lookup unknown contract');
    res = await request('GET', '/lookup/contract-x');
    console.log('Response:', res);
    
    console.log('\n3. Compare matching hashes');
    res = await request('POST', '/compare', { hash1: 'a3f01b3c', hash2: 'a3f01b3c' });
    console.log('Response:', res);
    
    console.log('\n4. Compare non-matching hashes');
    res = await request('POST', '/compare', { hash1: 'a3f01b3c', hash2: 'b7d2f9e4' });
    console.log('Response:', res);

  } catch (err) {
    console.error(err);
  } finally {
    server.close();
  }
});
