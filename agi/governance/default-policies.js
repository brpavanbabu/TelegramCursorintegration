'use strict';

/**
 * Baseline enterprise policy pack. Deployments extend or replace these;
 * the engine remains default-deny for anything not covered here.
 */

const DEFAULT_POLICIES = [
    {
        id: 'deny-critical-risk',
        description: 'Critical-risk tools are never executed autonomously',
        priority: 100,
        match: { riskLevel: 'critical' },
        effect: 'deny'
    },
    {
        id: 'approve-high-risk',
        description: 'High-risk tools require human approval',
        priority: 90,
        match: { riskLevel: 'high' },
        effect: 'require_approval'
    },
    {
        id: 'deny-secret-args',
        description: 'Block tool calls whose arguments appear to contain secrets',
        priority: 95,
        match: {
            args: (args) => {
                const flat = JSON.stringify(args || {}).toLowerCase();
                return /(api[_-]?key|password|secret|private[_-]?key|bearer\s)/.test(flat);
            }
        },
        effect: 'deny'
    },
    {
        id: 'allow-low-medium-risk',
        description: 'Low/medium-risk tools run autonomously',
        priority: 10,
        match: { riskLevel: ['low', 'medium'] },
        effect: 'allow'
    }
];

module.exports = { DEFAULT_POLICIES };
