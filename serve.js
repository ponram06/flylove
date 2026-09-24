const http = require('http');
const fs = require('fs');
const path = require('path');

const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const file = path.join(__dirname, p);
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
  fs.createReadStream(file).pipe(res);
});

server.listen(8080, () => {
  console.log('Server running on http://localhost:8080');
});
