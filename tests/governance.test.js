'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { PolicyEngine } = require('../agi/governance/policy-engine');
const { DEFAULT_POLICIES } = require('../agi/governance/default-policies');
const { RBAC } = require('../agi/governance/rbac');
const { AuditLog } = require('../agi/governance/audit-log');
const { ApprovalManager } = require('../agi/governance/approval-manager');

test('policy engine is default-deny when no rule matches', () => {
    const engine = new PolicyEngine();
    const verdict = engine.evaluate({ tool: 'anything', riskLevel: 'low' });
    assert.strictEqual(verdict.decision, 'deny');
});

test('policy engine matches globs, arrays and predicates', () => {
    const engine = new PolicyEngine({
        rules: [
            { id: 'glob', priority: 10, match: { tool: 'fs.*' }, effect: 'allow' },
            { id: 'arr', priority: 20, match: { riskLevel: ['high', 'critical'] }, effect: 'require_approval' },
            { id: 'pred', priority: 30, match: { args: a => JSON.stringify(a).includes('rm -rf') }, effect: 'deny' }
        ]
    });
    assert.strictEqual(engine.evaluate({ tool: 'fs.read', riskLevel: 'low' }).decision, 'allow');
    assert.strictEqual(engine.evaluate({ tool: 'fs.write', riskLevel: 'high' }).decision, 'require_approval');
    assert.strictEqual(
        engine.evaluate({ tool: 'fs.read', riskLevel: 'low', args: { cmd: 'rm -rf /' } }).decision,
        'deny'
    );
});

test('most restrictive effect wins on equal priority', () => {
    const engine = new PolicyEngine({
        rules: [
            { id: 'a', priority: 10, match: { tool: 'x' }, effect: 'allow' },
            { id: 'b', priority: 10, match: { tool: 'x' }, effect: 'deny' }
        ]
    });
    assert.strictEqual(engine.evaluate({ tool: 'x' }).decision, 'deny');
});

test('default policy pack: critical denied, high needs approval, low allowed', () => {
    const engine = new PolicyEngine({ rules: DEFAULT_POLICIES });
    assert.strictEqual(engine.evaluate({ tool: 't', riskLevel: 'critical' }).decision, 'deny');
    assert.strictEqual(engine.evaluate({ tool: 't', riskLevel: 'high' }).decision, 'require_approval');
    assert.strictEqual(engine.evaluate({ tool: 't', riskLevel: 'low' }).decision, 'allow');
    assert.strictEqual(
        engine.evaluate({ tool: 't', riskLevel: 'low', args: { key: 'my api_key is 123' } }).decision,
        'deny'
    );
});

test('rbac supports globs and inheritance without cycles', () => {
    const rbac = new RBAC();
    rbac.defineRole('reader', ['tool:fs.read']);
    rbac.defineRole('operator', ['tool:workspace.*'], { inherits: ['reader'] });
    rbac.defineRole('admin', ['*'], { inherits: ['operator'] });
    // introduce a cycle deliberately; resolution must still terminate
    rbac.defineRole('reader2', [], { inherits: ['admin2'] });
    rbac.defineRole('admin2', [], { inherits: ['reader2'] });

    assert.ok(rbac.can('reader', 'tool:fs.read'));
    assert.ok(!rbac.can('reader', 'tool:fs.write'));
    assert.ok(rbac.can('operator', 'tool:workspace.list'));
    assert.ok(rbac.can('operator', 'tool:fs.read'));
    assert.ok(rbac.can('admin', 'tool:anything.at.all'));
    assert.ok(!rbac.can('reader2', 'tool:x'));
});

test('audit log chains hashes and detects tampering', () => {
    const audit = new AuditLog({ clock: () => '2026-01-01T00:00:00Z' });
    audit.record({ actor: 'a1', action: 'tool.execute', decision: 'allow' });
    audit.record({ actor: 'a1', action: 'tool.execute', decision: 'deny' });
    audit.record({ actor: 'a2', action: 'task.finished' });

    assert.strictEqual(audit.verify().valid, true);

    audit.entries[1].decision = 'allow'; // tamper
    const check = audit.verify();
    assert.strictEqual(check.valid, false);
    assert.strictEqual(check.brokenAt, 2);
});

test('audit query filters by actor and action', () => {
    const audit = new AuditLog();
    audit.record({ actor: 'a1', action: 'tool.execute' });
    audit.record({ actor: 'a2', action: 'task.finished' });
    assert.strictEqual(audit.query({ actor: 'a1' }).length, 1);
    assert.strictEqual(audit.query({ action: 'task.finished' })[0].actor, 'a2');
});

test('approval manager approves and denies pending requests', async () => {
    const approvals = new ApprovalManager({ timeoutMs: 60000 });
    let capturedId;
    approvals.onRequest = ({ id }) => { capturedId = id; };

    const pending = approvals.requestApproval({ agentId: 'a1', tool: 'deploy', riskLevel: 'high' });
    await new Promise(r => setImmediate(r));
    assert.ok(capturedId);
    assert.strictEqual(approvals.listPending().length, 1);

    approvals.approve(capturedId, 'alice');
    const result = await pending;
    assert.strictEqual(result.approved, true);
    assert.strictEqual(result.approver, 'alice');
    assert.strictEqual(approvals.listPending().length, 0);
});

test('approval manager times out to a denial', async () => {
    const approvals = new ApprovalManager({ timeoutMs: 20 });
    const result = await approvals.requestApproval({ agentId: 'a1', tool: 'deploy' });
    assert.strictEqual(result.approved, false);
    assert.match(result.reason, /timed out/);
});
