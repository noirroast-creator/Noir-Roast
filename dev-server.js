// Tiny local web server for the NOIR ROAST site. No packages to install.
//   npm run dev                         then open http://localhost:5173
//   PORT=5200 npm run dev               use another port (Windows PowerShell: $env:PORT=5200; npm run dev)
// For local preview only. Do not upload this file to your web host.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 5173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const send = (res, status, text) => {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
};

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end('Method not allowed'); return; }

  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { send(res, 400, 'Bad request'); return; }
  if (pathname.endsWith('/')) pathname += 'index.html';

  const file = path.normalize(path.join(ROOT, pathname));
  const relative = path.relative(ROOT, file);
  // Stay inside the project, and never serve hidden folders, the database scripts or node_modules.
  const blocked = relative.startsWith('..') || path.isAbsolute(relative)
    || relative.split(path.sep).some((part) => part.startsWith('.') || part === 'node_modules' || part === 'supabase');
  if (blocked) { send(res, 404, 'Not found'); return; }

  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) { send(res, 404, 'Not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store', // always show your latest edits
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Close the other server, or use another port, e.g. PORT=5200 npm run dev`);
  else console.error(error.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`NOIR ROAST is running at http://localhost:${PORT}   (press Ctrl+C to stop)`);
});
