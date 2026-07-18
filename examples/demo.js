#!/usr/bin/env node
'use strict';

/**
 * End-to-end demo of the enterprise AGI runtime — runs fully offline with
 * the MockProvider so you can see governance in action:
 *
 *   node examples/demo.js
 *
 * Swap in the real model by setting:
 *   AGI_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-... node examples/demo.js
 */

const { createRuntime } = require('../agi');
const { MockProvider } = require('../agi/providers');

async function main() {
    const scripted = new MockProvider([
        '{"thought": "First inspect the workspace", "action": {"tool": "workspace.list", "args": {}}}',
        '{"thought": "Now try to deploy — this is high risk and needs approval", "action": {"tool": "deploy.production", "args": {"target": "vercel"}}}',
        '{"thought": "Deployment approved and done", "final": "Workspace inspected and deployed to production (with human approval)."}'
    ]);

    const runtime = createRuntime(
        { logLevel: 'warn' },
        {
            provider: process.env.AGI_PROVIDER === 'anthropic' ? undefined : scripted,
            // Auto-approve in the demo; in production this is a human via Telegram/Slack.
            onApprovalRequest: ({ id, ctx }) => {
                console.log(`🛂 Approval requested for ${ctx.tool} (${ctx.riskLevel}) — auto-approving as "demo-operator"`);
                runtime.approvals.approve(id, 'demo-operator');
            }
        }
    );

    // 1. Governance setup: roles and (optionally) extra policy rules.
    runtime.rbac.defineRole('builder', ['tool:workspace.*', 'tool:deploy.*']);
    runtime.policyEngine.addRule({
        id: 'deny-weekend-deploys',
        description: 'Example custom rule: block deploys tagged do-not-deploy',
        priority: 95,
        match: { tool: 'deploy.*', args: (a) => a && a.target === 'forbidden' },
        effect: 'deny'
    });

    // 2. Register governed tools.
    runtime.tools.register({
        name: 'workspace.list',
        description: 'List files in the workspace',
        riskLevel: 'low',
        handler: async () => ({ files: ['index.html', 'app.js', 'style.css'] })
    });
    runtime.tools.register({
        name: 'deploy.production',
        description: 'Deploy the workspace to production',
        riskLevel: 'high', // -> requires human approval per default policy pack
        inputSchema: { target: { type: 'string', required: true } },
        handler: async ({ target }) => ({ deployed: true, target, url: `https://demo.${target}.app` })
    });

    // 3. Teach the runtime something (semantic memory).
    runtime.memory.semantic.store('This project deploys its frontend to Vercel');

    // 4. Create an agent and submit a task.
    runtime.createAgent({
        id: 'builder-1',
        role: 'builder',
        goal: 'Build and ship what the user asks for, safely.',
        capabilities: ['build']
    });

    const { taskId, done } = runtime.orchestrator.submitTask({
        description: 'Inspect the workspace and deploy it to production',
        capability: 'build',
        requestedBy: 'demo-user'
    });
    console.log(`📨 Task ${taskId} submitted`);

    const result = await done;
    console.log(`\n${result.status === 'completed' ? '✅' : '⚠️'} Task ${result.status}: ${result.output}\n`);
    console.log('Steps taken:');
    result.steps.forEach(s => console.log(`  ${s.step}. [${s.type}] ${s.tool || ''} ${s.outcome || ''}`));

    const health = runtime.health();
    console.log('\n🩺 Health:', JSON.stringify(health.orchestrator));
    console.log(`🔏 Audit chain valid: ${health.auditChain.valid} (${runtime.audit.entries.length} entries)`);
    console.log('\nLast audit entries:');
    runtime.audit.query({ limit: 5 }).forEach(e =>
        console.log(`  #${e.seq} ${e.actor} ${e.action} ${e.decision || ''} ${JSON.stringify(e.details)}`));
}

main().catch(err => {
    console.error('Demo failed:', err);
    process.exit(1);
});
