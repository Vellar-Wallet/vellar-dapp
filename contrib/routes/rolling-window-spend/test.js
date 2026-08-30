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
    const account = 'acc_123';
    console.log('1. Check initial allowance');
    let res = await request('GET', `/allowance/${account}`);
    console.log('Response:', res);

    console.log('\n2. Spend 400');
    res = await request('POST', `/spend/${account}`, { amount: 400 });
    console.log('Response:', res);
    
    console.log('\n3. Spend 500');
    res = await request('POST', `/spend/${account}`, { amount: 500 });
    console.log('Response:', res);
    
    console.log('\n4. Spend 200 (should fail, limit is 1000)');
    res = await request('POST', `/spend/${account}`, { amount: 200 });
    console.log('Response:', res);
    
    console.log('\n5. Final allowance');
    res = await request('GET', `/allowance/${account}`);
    console.log('Response:', res);

  } catch (err) {
    console.error(err);
  } finally {
    server.close();
  }
});
