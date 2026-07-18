'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createRuntime } = require('../agi');
const { MockProvider } = require('../agi/providers');
const { extractJson } = require('../agi/core/agent');

function buildRuntime(responses) {
    const runtime = createRuntime(
        { logLevel: 'error' },
        { provider: new MockProvider(responses) }
    );
    runtime.rbac.defineRole('worker', ['tool:*']);
    runtime.tools.register({
        name: 'math.add',
        description: 'adds two numbers',
        riskLevel: 'low',
        inputSchema: {
            a: { type: 'number', required: true },
            b: { type: 'number', required: true }
        },
        handler: async ({ a, b }) => ({ sum: a + b })
    });
    return runtime;
}

test('extractJson tolerates prose and code fences', () => {
    assert.deepStrictEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepStrictEqual(extractJson('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
    assert.deepStrictEqual(extractJson('prefix {"a":{"b":"}"}} suffix'), { a: { b: '}' } });
    assert.strictEqual(extractJson('no json here'), null);
});

test('agent executes a tool then finishes; orchestrator resolves the task', async () => {
    const runtime = buildRuntime([
        '{"thought": "add them", "action": {"tool": "math.add", "args": {"a": 2, "b": 3}}}',
        '{"thought": "done", "final": "The sum is 5"}'
    ]);
    runtime.createAgent({ id: 'calc', role: 'worker', capabilities: ['math'] });

    const { taskId, done } = runtime.orchestrator.submitTask({
        description: 'What is 2 + 3?',
        capability: 'math',
        requestedBy: 'test'
    });
    const result = await done;

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.output, 'The sum is 5');
    assert.strictEqual(result.steps.length, 2);
    assert.strictEqual(runtime.orchestrator.getTask(taskId).status, 'completed');
    assert.strictEqual(runtime.audit.verify().valid, true);
});

test('agent survives a denied tool call and adapts', async () => {
    const runtime = buildRuntime([
        '{"thought": "try forbidden", "action": {"tool": "nope.tool", "args": {}}}',
        '{"thought": "fallback", "final": "Could not use that tool"}'
    ]);
    runtime.createAgent({ id: 'a1', role: 'worker', capabilities: ['x'] });
    const { done } = runtime.orchestrator.submitTask({ description: 'do it', capability: 'x' });
    const result = await done;
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.steps[0].outcome, 'error');
});

test('agent stops at maxSteps', async () => {
    const loop = '{"thought": "again", "action": {"tool": "math.add", "args": {"a": 1, "b": 1}}}';
    const runtime = createRuntime(
        { logLevel: 'error', agentDefaults: { maxSteps: 3 } },
        { provider: new MockProvider([loop, loop, loop, loop, loop]) }
    );
    runtime.rbac.defineRole('worker', ['tool:*']);
    runtime.tools.register({
        name: 'math.add', riskLevel: 'low', handler: async () => ({ ok: true })
    });
    runtime.createAgent({ id: 'looper', role: 'worker', capabilities: ['x'] });
    const { done } = runtime.orchestrator.submitTask({ description: 'loop', capability: 'x' });
    const result = await done;
    assert.strictEqual(result.status, 'max_steps_reached');
});

test('orchestrator routes by capability and rejects unknown capabilities', async () => {
    const runtime = buildRuntime(['{"final": "ok"}']);
    runtime.createAgent({ id: 'coder', role: 'worker', capabilities: ['code'] });
    assert.throws(
        () => runtime.orchestrator.submitTask({ description: 'x', capability: 'video' }),
        /No agent registered with capability/
    );
    const { done } = runtime.orchestrator.submitTask({ description: 'x', capability: 'code' });
    assert.strictEqual((await done).status, 'completed');
});

test('orchestrator honors the concurrency limit', async () => {
    let concurrent = 0;
    let peak = 0;
    const provider = {
        async complete() {
            concurrent += 1;
            peak = Math.max(peak, concurrent);
            await new Promise(r => setTimeout(r, 20));
            concurrent -= 1;
            return { text: '{"final": "done"}', usage: {} };
        }
    };
    const runtime = createRuntime(
        { logLevel: 'error', orchestrator: { maxConcurrent: 2 } },
        { provider }
    );
    runtime.rbac.defineRole('worker', ['tool:*']);
    for (let i = 0; i < 4; i++) {
        runtime.createAgent({ id: `a${i}`, role: 'worker', capabilities: ['x'] });
    }
    const tasks = Array.from({ length: 6 }, (_, i) =>
        runtime.orchestrator.submitTask({ description: `t${i}`, capability: 'x' }).done
    );
    await Promise.all(tasks);
    assert.ok(peak <= 2, `peak concurrency was ${peak}`);
});

test('runtime health reports a valid audit chain', async () => {
    const runtime = buildRuntime(['{"final": "ok"}']);
    runtime.createAgent({ id: 'a1', role: 'worker', capabilities: ['x'] });
    await runtime.orchestrator.submitTask({ description: 'x', capability: 'x' }).done;
    const health = runtime.health();
    assert.strictEqual(health.status, 'ok');
    assert.strictEqual(health.auditChain.valid, true);
    assert.strictEqual(health.orchestrator.tasks.completed, 1);
});
