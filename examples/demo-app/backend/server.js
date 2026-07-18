/**
 * Demo backend for the fullstack-demo stack — a tiny dependency-free API.
 * PlugStack injects PORT (and any env you add in the stack file).
 */
'use strict';

const http = require('http');

const PORT = Number(process.env.PORT || 4000);
const DB_URL = process.env.DATABASE_URL || '(not configured)';

const todos = [{ id: 1, text: 'Ship the pluggable platform', done: true }];

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'demo-backend', db: DB_URL }));
    return;
  }
  if (req.url === '/api/todos') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(todos));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}).listen(PORT, () => console.log(`demo-backend listening on http://localhost:${PORT}`));
