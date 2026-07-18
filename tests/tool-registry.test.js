'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { ToolRegistry } = require('../agi/tools/tool-registry');
const { PolicyEngine } = require('../agi/governance/policy-engine');
const { DEFAULT_POLICIES } = require('../agi/governance/default-policies');
const { RBAC } = require('../agi/governance/rbac');
const { AuditLog } = require('../agi/governance/audit-log');
const { ApprovalManager } = require('../agi/governance/approval-manager');
const { MetricsRegistry } = require('../agi/observability/metrics');

function buildRegistry(extra = {}) {
    const audit = new AuditLog();
    const rbac = new RBAC();
    rbac.defineRole('worker', ['tool:echo', 'tool:danger', 'tool:flaky']);
    const registry = new ToolRegistry({
        policyEngine: new PolicyEngine({ rules: DEFAULT_POLICIES, audit }),
        rbac,
        audit,
        metrics: new MetricsRegistry(),
        ...extra
    });
    return { registry, audit, rbac };
}

test('executes an allowed tool and audits it', async () => {
    const { registry, audit } = buildRegistry();
    registry.register({
        name: 'echo',
        description: 'echoes input',
        riskLevel: 'low',
        inputSchema: { text: { type: 'string', required: true } },
        handler: async ({ text }) => ({ echoed: text })
    });
    const result = await registry.execute('echo', { text: 'hi' }, { agentId: 'a1', role: 'worker' });
    assert.deepStrictEqual(result, { echoed: 'hi' });
    const executions = audit.query({ action: 'tool.execute' });
    assert.ok(executions.some(e => e.decision === 'allow'));
});

test('rejects invalid arguments before touching the handler', async () => {
    const { registry } = buildRegistry();
    let called = false;
    registry.register({
        name: 'echo',
        riskLevel: 'low',
        inputSchema: { text: { type: 'string', required: true } },
        handler: async () => { called = true; }
    });
    await assert.rejects(
        registry.execute('echo', {}, { agentId: 'a1', role: 'worker' }),
        (err) => err.code === 'INVALID_ARGS'
    );
    assert.strictEqual(called, false);
});

test('denies by RBAC when role lacks the permission', async () => {
    const { registry } = buildRegistry();
    registry.register({ name: 'echo', riskLevel: 'low', handler: async () => 'x' });
    await assert.rejects(
        registry.execute('echo', {}, { agentId: 'a1', role: 'guest' }),
        (err) => err.code === 'RBAC_DENIED'
    );
});

test('denies critical-risk tools by policy', async () => {
    const { registry } = buildRegistry();
    registry.register({ name: 'danger', riskLevel: 'critical', handler: async () => 'boom' });
    await assert.rejects(
        registry.execute('danger', {}, { agentId: 'a1', role: 'worker' }),
        (err) => err.code === 'POLICY_DENIED'
    );
});

test('high-risk tool waits for human approval and runs when granted', async () => {
    const approvals = new ApprovalManager({ timeoutMs: 60000 });
    const { registry } = buildRegistry({ approvalManager: approvals });
    registry.register({ name: 'danger', riskLevel: 'high', handler: async () => 'deployed' });

    let requestId;
    approvals.onRequest = ({ id }) => { requestId = id; };

    const pending = registry.execute('danger', {}, { agentId: 'a1', role: 'worker' });
    await new Promise(r => setImmediate(r));
    approvals.approve(requestId, 'ops');
    assert.strictEqual(await pending, 'deployed');
});

test('high-risk tool fails when approval is denied', async () => {
    const approvals = new ApprovalManager({ timeoutMs: 60000 });
    const { registry } = buildRegistry({ approvalManager: approvals });
    registry.register({ name: 'danger', riskLevel: 'high', handler: async () => 'deployed' });

    approvals.onRequest = ({ id }) => approvals.deny(id, 'ops', 'not today');
    await assert.rejects(
        registry.execute('danger', {}, { agentId: 'a1', role: 'worker' }),
        (err) => err.code === 'APPROVAL_DENIED'
    );
});

test('circuit breaker opens after repeated failures', async () => {
    const { registry } = buildRegistry();
    registry.options.circuitBreaker = { failureThreshold: 2, resetTimeoutMs: 60000 };
    registry.register({
        name: 'flaky',
        riskLevel: 'low',
        handler: async () => { throw new Error('downstream unavailable'); }
    });
    const ctx = { agentId: 'a1', role: 'worker' };
    await assert.rejects(registry.execute('flaky', {}, ctx), /downstream/);
    await assert.rejects(registry.execute('flaky', {}, ctx), /downstream/);
    await assert.rejects(registry.execute('flaky', {}, ctx), (err) => err.code === 'CIRCUIT_OPEN');
});
