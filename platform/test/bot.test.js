/**
 * Deploy-bot tests — exercise the full product flow (auth -> list -> deploy
 * confirmation -> button press -> audit) without a Telegram token.
 * The deploy/stop flow runs against the REAL engine in a temp workspace.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const realEngine = require('../engine/api');
const { AuthManager } = require('../bot/auth');
const { Router } = require('../bot/commands');
const audit = require('../bot/audit');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  ✖ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

function msg(chatId, text, username = 'alice') {
  return { chat: { id: chatId }, from: { username }, text };
}

function callback(chatId, data) {
  return { id: 'q1', data, from: { username: 'alice' }, message: { chat: { id: chatId }, message_id: 1 } };
}

/** Build a temp workspace with a tiny real stack (one process service). */
function makeWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'plugstack-bot-'));
  const appDir = path.join(ws, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'server.js'), `
    const http = require('http');
    http.createServer((req, res) => res.end('{"ok":true}')).listen(process.env.PORT);
  `);
  fs.mkdirSync(path.join(ws, 'stacks'));
  fs.writeFileSync(path.join(ws, 'stacks', 'tiny.json'), JSON.stringify({
    name: 'tiny',
    description: 'test stack',
    services: {
      api: { plugin: 'node-service', config: { cwd: '../app', command: 'node server.js', port: 43119, health: undefined } },
    },
  }));
  return ws;
}

async function main() {
  console.log('\nDeploy-bot tests\n');

  const ws = makeWorkspace();
  const auth = new AuthManager(ws, 'hunter2');
  const router = new Router({ workspaceDir: ws, engine: realEngine, auth });
  const CHAT = 1001;

  await test('unauthenticated user is asked for the password', async () => {
    const r = await router.handleMessage(msg(CHAT, '/start'));
    assert.match(r.text, /Password required/);
  });

  await test('wrong password decrements attempts and is audited', async () => {
    const r = await router.handleMessage(msg(CHAT, 'wrong'));
    assert.match(r.text, /Incorrect password \(2 attempt/);
    const events = audit.tail(ws, 5);
    assert.strictEqual(events[events.length - 1].action, 'auth.fail');
  });

  await test('three failures trigger lockout', async () => {
    const lockAuth = new AuthManager(ws, 'pw', { now: () => 1000 });
    lockAuth.attempt(99, 'a');
    lockAuth.attempt(99, 'b');
    const r3 = lockAuth.attempt(99, 'c');
    assert.strictEqual(r3.locked, true);
    const r4 = lockAuth.attempt(99, 'pw'); // correct password but locked
    assert.strictEqual(r4.ok, false);
    assert.strictEqual(r4.locked, true);
  });

  await test('correct password authorizes and persists across restarts', async () => {
    const r = await router.handleMessage(msg(CHAT, 'hunter2'));
    assert.match(r.text, /Password verified/);
    const auth2 = new AuthManager(ws, 'hunter2');
    assert.strictEqual(auth2.isAuthorized(CHAT), true);
  });

  await test('/stacks lists the stack', async () => {
    const r = await router.handleMessage(msg(CHAT, '/stacks'));
    assert.match(r.text, /tiny \(1 services\)/);
  });

  await test('/deploy asks for confirmation with buttons', async () => {
    const r = await router.handleMessage(msg(CHAT, '/deploy tiny'));
    assert.match(r.text, /Deploy stack "tiny"\?/);
    assert.strictEqual(r.keyboard[0][0].data, 'deploy:tiny');
    assert.strictEqual(r.keyboard[0][1].data, 'cancel');
  });

  await test('/deploy of unknown stack fails cleanly, no buttons', async () => {
    const r = await router.handleMessage(msg(CHAT, '/deploy nope'));
    assert.match(r.text, /Stack not found/);
    assert.strictEqual(r.keyboard, undefined);
  });

  await test('cancel button cancels', async () => {
    const r = await router.handleCallback(callback(CHAT, 'cancel'));
    assert.strictEqual(r.text, 'Cancelled.');
  });

  await test('deploy button REALLY deploys the stack (end to end)', async () => {
    const r = await router.handleCallback(callback(CHAT, 'deploy:tiny'));
    assert.match(r.text, /Stack "tiny" deployed/);
    assert.match(r.text, /✅ api/);
    // Service is actually reachable
    const body = await new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:43119/', (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
    assert.strictEqual(JSON.parse(body).ok, true);
  });

  await test('/status shows it running', async () => {
    const r = await router.handleMessage(msg(CHAT, '/status tiny'));
    assert.match(r.text, /✅ api/);
  });

  await test('/logs returns log lines', async () => {
    const r = await router.handleMessage(msg(CHAT, '/logs tiny api'));
    assert.match(r.text, /Logs for api/);
  });

  await test('stop button stops it, and it is audited', async () => {
    const r = await router.handleCallback(callback(CHAT, 'stop:tiny'));
    assert.match(r.text, /stopped/);
    const events = audit.tail(ws, 20).map((e) => e.action);
    assert.ok(events.includes('deploy'), 'deploy audited');
    assert.ok(events.includes('stop'), 'stop audited');
  });

  await test('/audit shows the trail with usernames', async () => {
    const r = await router.handleMessage(msg(CHAT, '/audit'));
    assert.match(r.text, /@alice\s+deploy tiny/);
  });

  await test('unauthorized button presses are rejected', async () => {
    const r = await router.handleCallback(callback(4242, 'deploy:tiny'));
    assert.match(r.text, /Not authorized/);
  });

  // give killed process groups a moment, then clean up
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(ws, { recursive: true, force: true });

  console.log(`\n${passed} tests passed${failures.length ? `, ${failures.length} FAILED` : ''}\n`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
