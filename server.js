// SmartGuard Dashboard & Live API Proxy Server
// Provides static asset serving + zero-CORS /api forwarding to ESP32
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const ESP32_HOST = '192.168.4.1';
const DASHBOARD_DIR = path.join(__dirname, 'dashboard');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  // CORS & Chrome Private Network Access headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Transparent API Proxy to ESP32
  if (req.url.startsWith('/api')) {
    const proxyReq = http.request({
      hostname: ESP32_HOST,
      port: 80,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: ESP32_HOST },
      timeout: 4000
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ESP32 unreachable', details: err.message }));
    });

    req.pipe(proxyReq);
    return;
  }

  // Serve static files
  let safePath = req.url.split('?')[0];
  if (safePath === '/' || safePath === '') safePath = '/index.html';
  if (!path.extname(safePath)) {
    if (fs.existsSync(path.join(DASHBOARD_DIR, safePath + '.html'))) {
      safePath += '.html';
    }
  }

  let filePath = path.join(DASHBOARD_DIR, safePath);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(DASHBOARD_DIR, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server Error: ' + err.message);
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[SmartGuard] Dashboard & Proxy running at http://localhost:${PORT}`);
  console.log(`[SmartGuard] Forwarding /api requests to http://${ESP32_HOST}`);
});

