const server = require('./index');
const http = require('http');

server.listen(0, async () => {
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;
  
  const request = (method, path) => new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${path}`, { method }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.end();
  });

  try {
    console.log('1. Build Payment');
    const built = await request('POST', '/build');
    console.log('Built:', built);
    
    console.log('\n2. Review Payment');
    const reviewed = await request('POST', `/review/${built.id}`);
    console.log('Reviewed:', reviewed);
    
    console.log('\n3. Submit Payment');
    const submitted = await request('POST', `/submit/${built.id}`);
    console.log('Submitted:', submitted);
    
    console.log('\n4. Poll Status (needs 3 polls to settle)');
    for (let i = 1; i <= 4; i++) {
      const status = await request('GET', `/status/${built.id}`);
      console.log(`Poll ${i}:`, status);
    }
  } catch (err) {
    console.error(err);
  } finally {
    server.close();
  }
});
