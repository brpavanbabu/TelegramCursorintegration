/**
 * Smoke tests for the PlugStack engine — no Docker, no network, no side
 * effects outside a temp directory. Run with: npm test
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { interpolate } = require('../engine/interpolate');
const { loadRegistry } = require('../engine/registry');
const { resolveStack, topoSort } = require('../engine/resolver');
const { toYaml } = require('../engine/yaml');
const { buildCompose } = require('../engine/runners/docker-runner');

const repoRoot = path.join(__dirname, '..', '..');
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    console.error(`  ✖ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('\nPlugStack smoke tests\n');

test('interpolate resolves config keys and preserves number types', () => {
  const ctx = { name: 'svc', config: { port: 4000, host: 'localhost' } };
  assert.strictEqual(interpolate('${port}', ctx), 4000);
  assert.strictEqual(interpolate('http://${host}:${port}/x', ctx), 'http://localhost:4000/x');
});

test('interpolate resolves cross-service references', () => {
  const ctx = {
    name: 'api',
    config: {},
    services: { db: { config: { port: 5432, user: 'app' } } },
  };
  assert.strictEqual(interpolate('postgres://${service.db.user}@localhost:${service.db.port}', ctx),
    'postgres://app@localhost:5432');
});

test('interpolate rejects unknown placeholders', () => {
  assert.throws(() => interpolate('${nope}', { name: 'x', config: {} }), /Unknown placeholder/);
});

test('registry discovers all built-in plugins', () => {
  const registry = loadRegistry(repoRoot);
  for (const name of ['kafka', 'postgres', 'redis', 'mongodb', 'static-frontend', 'node-service']) {
    assert.ok(registry.has(name), `missing plugin: ${name}`);
  }
});

test('topoSort orders dependencies and detects cycles', () => {
  const order = topoSort({
    web: { dependsOn: ['api'] },
    api: { dependsOn: ['db'] },
    db: {},
  });
  assert.ok(order.indexOf('db') < order.indexOf('api'));
  assert.ok(order.indexOf('api') < order.indexOf('web'));
  assert.throws(() => topoSort({ a: { dependsOn: ['b'] }, b: { dependsOn: ['a'] } }), /cycle/i);
});

test('fullstack-demo stack resolves with interpolated env', () => {
  const registry = loadRegistry(repoRoot);
  const { plan } = resolveStack(path.join(repoRoot, 'stacks', 'fullstack-demo.json'), registry);
  const api = plan.find((e) => e.name === 'api');
  const web = plan.find((e) => e.name === 'web');
  assert.strictEqual(api.env.PORT, 4000);
  assert.strictEqual(web.env.PORT, 8080);
  assert.ok(String(web.env.ROOT).endsWith(path.join('examples', 'demo-app', 'frontend')));
});

test('full-platform stack wires DB/Kafka/Redis URLs into the backend env', () => {
  const registry = loadRegistry(repoRoot);
  const { plan } = resolveStack(path.join(repoRoot, 'stacks', 'full-platform.json'), registry);
  const api = plan.find((e) => e.name === 'api');
  assert.strictEqual(api.env.DATABASE_URL, 'postgres://demo:demo@localhost:5432/demo');
  assert.strictEqual(api.env.KAFKA_BROKERS, 'localhost:9092');
  assert.strictEqual(api.env.REDIS_URL, 'redis://localhost:6379');
});

test('docker compose generation emits valid structure', () => {
  const registry = loadRegistry(repoRoot);
  const { plan } = resolveStack(path.join(repoRoot, 'stacks', 'full-platform.json'), registry);
  const dockerEntries = plan.filter((e) => e.runner === 'docker');
  const doc = buildCompose('full-platform', dockerEntries);
  assert.ok(doc.services.kafka.image.startsWith('bitnami/kafka'));
  assert.deepStrictEqual(doc.services.db.ports, ['5432:5432']);
  assert.ok(doc.volumes.kafka_data);
  const yaml = toYaml(doc);
  assert.ok(yaml.includes('image: "postgres:16-alpine"') || yaml.includes('image: postgres:16-alpine'));
  assert.ok(yaml.includes('"5432:5432"') || yaml.includes('5432:5432'));
});

test('workspace plugins override / extend built-ins', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugstack-'));
  const dir = path.join(tmp, 'plugins', 'my-plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    name: 'my-plugin', runner: 'process', command: 'node x.js',
  }));
  const registry = loadRegistry(tmp);
  assert.ok(registry.has('my-plugin'));
  assert.ok(registry.has('kafka'), 'built-ins still present');
  fs.rmSync(tmp, { recursive: true, force: true });
});

console.log(`\n${passed} tests passed${process.exitCode ? ', some FAILED' : ''}\n`);
