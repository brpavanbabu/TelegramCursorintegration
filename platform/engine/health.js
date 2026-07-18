/**
 * Health checks — wait until a service is actually ready, not just started.
 *
 * Manifest section:
 *   "health": { "type": "tcp",  "port": "${port}" }
 *   "health": { "type": "http", "port": "${port}", "path": "/health" }
 *   "health": { "type": "none" }
 */
'use strict';

const net = require('net');
const http = require('http');

function checkTcp(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: host || '127.0.0.1', timeout: 1500 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

function checkHttp(port, pathName, host) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: host || '127.0.0.1', port, path: pathName || '/', timeout: 2000 },
      (res) => { res.resume(); resolve(res.statusCode < 500); }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitHealthy(health, { timeoutMs = 60000, intervalMs = 1000, onTick } = {}) {
  if (!health || health.type === 'none') return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let ok = false;
    if (health.type === 'tcp') ok = await checkTcp(Number(health.port), health.host);
    else if (health.type === 'http') ok = await checkHttp(Number(health.port), health.path, health.host);
    else throw new Error(`Unknown health check type "${health.type}"`);
    if (ok) return true;
    if (onTick) onTick();
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function checkOnce(health) {
  if (!health || health.type === 'none') return null; // unknown
  if (health.type === 'tcp') return checkTcp(Number(health.port), health.host);
  if (health.type === 'http') return checkHttp(Number(health.port), health.path, health.host);
  return null;
}

module.exports = { waitHealthy, checkOnce };
