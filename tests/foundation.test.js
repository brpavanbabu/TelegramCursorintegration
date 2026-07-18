'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { retry, CircuitBreaker, RateLimiter } = require('../agi/resilience');
const { MemoryManager } = require('../agi/memory/memory-manager');
const { loadConfig } = require('../agi/config/config');
const { Logger, deepRedact } = require('../agi/observability/logger');
const { MetricsRegistry } = require('../agi/observability/metrics');
const { EventBus } = require('../agi/core/event-bus');

test('retry retries retryable errors with backoff and eventually succeeds', async () => {
    let attempts = 0;
    const delays = [];
    const result = await retry(
        async () => {
            attempts += 1;
            if (attempts < 3) throw new Error('transient');
            return 'ok';
        },
        { attempts: 5, baseDelayMs: 10, jitter: false, sleep: async (ms) => delays.push(ms) }
    );
    assert.strictEqual(result, 'ok');
    assert.strictEqual(attempts, 3);
    assert.deepStrictEqual(delays, [10, 20]);
});

test('retry gives up immediately on non-retryable errors', async () => {
    let attempts = 0;
    await assert.rejects(
        retry(async () => { attempts += 1; throw new Error('fatal'); },
            { attempts: 5, isRetryable: () => false, sleep: async () => {} }),
        /fatal/
    );
    assert.strictEqual(attempts, 1);
});

test('circuit breaker transitions closed -> open -> half-open -> closed', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000, now: () => now });
    const fail = () => breaker.execute(async () => { throw new Error('down'); });
    await assert.rejects(fail());
    await assert.rejects(fail());
    assert.strictEqual(breaker.getState(), 'open');
    await assert.rejects(breaker.execute(async () => 'x'), (e) => e.code === 'CIRCUIT_OPEN');
    now = 1500;
    assert.strictEqual(breaker.getState(), 'half-open');
    assert.strictEqual(await breaker.execute(async () => 'recovered'), 'recovered');
    assert.strictEqual(breaker.getState(), 'closed');
});

test('rate limiter refills tokens over time', () => {
    let now = 0;
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: () => now });
    assert.ok(limiter.tryAcquire());
    assert.ok(limiter.tryAcquire());
    assert.ok(!limiter.tryAcquire());
    now = 1000;
    assert.ok(limiter.tryAcquire());
});

test('working memory keeps a bounded window', () => {
    const memory = new MemoryManager({ workingMaxMessages: 3 });
    for (let i = 0; i < 5; i++) memory.working.add('user', `m${i}`);
    assert.strictEqual(memory.working.size(), 3);
    assert.match(memory.working.getContext(), /m4/);
    assert.ok(!memory.working.getContext().includes('m0'));
});

test('semantic memory recalls by relevance', () => {
    const memory = new MemoryManager();
    memory.semantic.store('The deployment pipeline uses Vercel for the frontend');
    memory.semantic.store('Database credentials rotate every 90 days');
    memory.semantic.store('Cats are excellent debuggers');
    const hits = memory.semantic.recall('how do we deploy the frontend to vercel');
    assert.ok(hits.length >= 1);
    assert.match(hits[0].text, /Vercel/);
});

test('memory buildContext combines facts, episodes and conversation', () => {
    const memory = new MemoryManager();
    memory.semantic.store('Project uses React with dark mode support');
    memory.episodic.record({ goal: 'build todo app', outcome: 'completed' });
    memory.working.add('user', 'add auth');
    const ctx = memory.buildContext('improve the react app');
    assert.match(ctx, /React/);
    assert.match(ctx, /build todo app/);
    assert.match(ctx, /add auth/);
});

test('config applies overrides, env vars, and validates', () => {
    const config = loadConfig(
        { orchestrator: { maxConcurrent: 4 } },
        { AGI_LOG_LEVEL: 'debug', AGI_AGENT_MAX_STEPS: '12' }
    );
    assert.strictEqual(config.orchestrator.maxConcurrent, 4);
    assert.strictEqual(config.logLevel, 'debug');
    assert.strictEqual(config.agentDefaults.maxSteps, 12);
    assert.throws(() => loadConfig({ logLevel: 'loud' }, {}), /logLevel/);
    assert.throws(() => loadConfig({ agentDefaults: { maxSteps: 0 } }, {}), /maxSteps/);
});

test('logger redacts secrets at any depth', () => {
    const lines = [];
    const logger = new Logger({ level: 'info', sink: (l) => lines.push(l) });
    logger.info('auth', { user: 'bob', nested: { apiKey: 'sk-123', password: 'hunter2' } });
    const entry = JSON.parse(lines[0]);
    assert.strictEqual(entry.nested.apiKey, '[REDACTED]');
    assert.strictEqual(entry.nested.password, '[REDACTED]');
    assert.strictEqual(entry.user, 'bob');
    assert.deepStrictEqual(
        deepRedact({ token: 'x', ok: 1 }, ['token']),
        { token: '[REDACTED]', ok: 1 }
    );
});

test('metrics tracks counters and histograms', async () => {
    const metrics = new MetricsRegistry();
    metrics.increment('hits', { route: 'a' });
    metrics.increment('hits', { route: 'a' });
    metrics.observe('lat', 10);
    metrics.observe('lat', 30);
    const snap = metrics.snapshot();
    assert.strictEqual(snap.counters['hits{route=a}'], 2);
    assert.strictEqual(snap.histograms.lat.avg, 20);
    await assert.rejects(metrics.time('op', {}, async () => { throw new Error('x'); }));
    assert.ok(metrics.snapshot().histograms['op{outcome=error}']);
});

test('event bus supports wildcards and isolates handler errors', async () => {
    const seen = [];
    const errors = [];
    const bus = new EventBus({ onError: (e) => errors.push(e.message) });
    bus.subscribe('task.*', (payload, topic) => seen.push(topic));
    bus.subscribe('task.completed', () => { throw new Error('handler boom'); });
    await bus.publish('task.completed', {});
    await bus.publish('task.failed', {});
    await bus.publish('other.topic', {});
    assert.deepStrictEqual(seen, ['task.completed', 'task.failed']);
    assert.deepStrictEqual(errors, ['handler boom']);
});
