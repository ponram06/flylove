const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 8080;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function send(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

  let p;
  try {
    p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  if (p === '/') p = '/index.html';

  // Resolve inside ROOT only, and never expose dotfiles (.git, .env, ...)
  const file = path.resolve(ROOT, '.' + path.posix.normalize(p));
  const rel = path.relative(ROOT, file);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).some(s => s.startsWith('.'))) {
    return send(res, 404, 'Not found');
  }
  const ext = path.extname(file);
  if (!mime[ext]) return send(res, 404, 'Not found');

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': mime[ext], 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
