'use strict';

/**
 * Agent — a governed reason/act loop.
 *
 * Each step the agent asks its model provider what to do next. The model
 * must answer with a single JSON object:
 *
 *   { "thought": "...", "action": { "tool": "fs.read", "args": {...} } }
 *   { "thought": "...", "final": "the finished answer" }
 *
 * Tool calls go through the ToolRegistry, so every action is subject to
 * RBAC, policy rules, approvals, rate limits and audit — the agent itself
 * has no privileged path around governance.
 */

function extractJson(text) {
    // Tolerate models that wrap JSON in prose or code fences.
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf('{');
    if (start === -1) return null;
    // Walk to the matching closing brace of the first object.
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < candidate.length; i++) {
        const ch = candidate[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') inString = !inString;
        if (inString) continue;
        if (ch === '{') depth++;
        if (ch === '}') {
            depth--;
            if (depth === 0) {
                try {
                    return JSON.parse(candidate.slice(start, i + 1));
                } catch (e) {
                    return null;
                }
            }
        }
    }
    return null;
}

class Agent {
    /**
     * @param {object} options
     * @param {string} options.id unique agent id
     * @param {string} options.role RBAC role for this agent
     * @param {string} [options.goal] standing mission statement
     * @param {string[]} [options.capabilities] routing tags for the orchestrator
     * @param {object} options.provider model Provider
     * @param {object} options.toolRegistry governed ToolRegistry
     * @param {object} [options.memory] MemoryManager
     * @param {object} [options.logger]
     * @param {object} [options.metrics]
     * @param {number} [options.maxSteps] hard cap on reason/act iterations
     */
    constructor(options) {
        if (!options.id || !options.provider || !options.toolRegistry) {
            throw new Error('Agent requires id, provider and toolRegistry');
        }
        this.id = options.id;
        this.role = options.role || 'agent';
        this.goal = options.goal || '';
        this.capabilities = options.capabilities || [];
        this.provider = options.provider;
        this.toolRegistry = options.toolRegistry;
        this.memory = options.memory || null;
        this.logger = options.logger || null;
        this.metrics = options.metrics || null;
        this.maxSteps = options.maxSteps || 8;
        // Loop-level deadline: hard wall-clock cap per task, independent of
        // step count, so slow tool calls cannot stretch a run indefinitely.
        this.maxDurationMs = options.maxDurationMs || 20 * 60 * 1000;
        // Adaptive prompt sections owned by the guarded evolution engine.
        this.promptSections = options.promptSections || null;
    }

    buildSystemPrompt() {
        const tools = this.toolRegistry.list()
            .map(t => `- ${t.name} (${t.riskLevel} risk): ${t.description}` +
                (Object.keys(t.inputSchema).length
                    ? ` args: ${JSON.stringify(t.inputSchema)}`
                    : ''))
            .join('\n');
        const adaptive = this.promptSections && this.promptSections.size
            ? 'Adaptive guidance (learned from operations):\n' +
              [...this.promptSections.entries()].map(([k, v]) => `[${k}] ${v}`).join('\n')
            : '';
        return [
            `You are agent "${this.id}" with role "${this.role}".`,
            this.goal ? `Mission: ${this.goal}` : '',
            adaptive,
            'You operate under a governance framework: actions may be denied by policy or need human approval. If an action is denied, adapt or finish with what you have.',
            'Available tools:',
            tools || '(none)',
            'Respond with EXACTLY ONE JSON object per turn, either:',
            '{"thought": "...", "action": {"tool": "<name>", "args": {...}}}',
            'or {"thought": "...", "final": "<your finished answer>"}'
        ].filter(Boolean).join('\n\n');
    }

    /**
     * @param {object} task { id, description, metadata }
     * @returns {Promise<{status: string, output: string, steps: Array}>}
     */
    async run(task) {
        const steps = [];
        const messages = [];
        const memoryContext = this.memory ? this.memory.buildContext(task.description) : '';
        messages.push({
            role: 'user',
            content: (memoryContext ? `${memoryContext}\n\n` : '') + `Task: ${task.description}`
        });

        let output = null;
        let status = 'incomplete';
        const deadline = Date.now() + this.maxDurationMs;

        for (let step = 1; step <= this.maxSteps; step++) {
            if (Date.now() > deadline) {
                status = 'deadline_exceeded';
                output = `Stopped: task exceeded the ${this.maxDurationMs}ms loop deadline.`;
                break;
            }
            let response;
            try {
                response = await this.provider.complete(messages, { system: this.buildSystemPrompt() });
            } catch (err) {
                status = 'error';
                output = `Model provider failed: ${err.message}`;
                break;
            }

            const parsed = extractJson(response.text);
            if (!parsed) {
                // Treat unparseable output as a final free-form answer.
                status = 'completed';
                output = response.text.trim();
                steps.push({ step, type: 'final', raw: true });
                break;
            }

            if (parsed.final !== undefined) {
                status = 'completed';
                output = String(parsed.final);
                steps.push({ step, type: 'final', thought: parsed.thought });
                break;
            }

            if (!parsed.action || !parsed.action.tool) {
                status = 'error';
                output = 'Agent produced neither an action nor a final answer';
                break;
            }

            const { tool, args } = parsed.action;
            let observation;
            try {
                const result = await this.toolRegistry.execute(tool, args || {}, {
                    agentId: this.id,
                    role: this.role,
                    taskId: task.id
                });
                observation = JSON.stringify(result === undefined ? { ok: true } : result);
                steps.push({ step, type: 'action', tool, outcome: 'success', thought: parsed.thought });
            } catch (err) {
                observation = `ERROR (${err.code || 'EXECUTION'}): ${err.message}`;
                steps.push({ step, type: 'action', tool, outcome: 'error', error: err.message, thought: parsed.thought });
            }

            if (this.logger) {
                this.logger.debug('Agent step', { agentId: this.id, taskId: task.id, step, tool });
            }

            messages.push({ role: 'assistant', content: response.text });
            messages.push({ role: 'user', content: `Observation: ${observation}` });
        }

        if (status === 'incomplete') {
            status = 'max_steps_reached';
            output = `Stopped after ${this.maxSteps} steps without a final answer.`;
        }

        if (this.memory) {
            this.memory.episodic.record({
                goal: task.description,
                agentId: this.id,
                outcome: status,
                stepsTaken: steps.length
            });
        }
        if (this.metrics) {
            this.metrics.increment('agent_tasks_total', { agent: this.id, status });
        }

        return { status, output, steps };
    }
}

module.exports = { Agent, extractJson };
