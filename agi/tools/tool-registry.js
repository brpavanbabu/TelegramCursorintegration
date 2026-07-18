'use strict';

/**
 * Governed tool registry — the single gate through which every agent action
 * passes. Execution order for each call:
 *
 *   1. schema validation of arguments
 *   2. RBAC check          (does the caller's role permit "tool:<name>"?)
 *   3. policy evaluation   (allow / deny / require_approval, default-deny)
 *   4. human approval      (when the policy demands it)
 *   5. rate limiting + circuit breaker + retry around the handler
 *   6. audit record + metrics for every outcome
 *
 * Tool definition:
 *   {
 *     name: 'fs.read',
 *     description: 'Read a file from the workspace',
 *     riskLevel: 'low' | 'medium' | 'high' | 'critical',
 *     inputSchema: { path: { type: 'string', required: true } },
 *     handler: async (args, ctx) => result
 *   }
 */

const { retry, CircuitBreaker, RateLimiter } = require('../resilience');
const { withTimeout } = require('../security/execution-boundaries');

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];

function validateArgs(schema, args) {
    const errors = [];
    for (const [field, spec] of Object.entries(schema || {})) {
        const value = args ? args[field] : undefined;
        if (value === undefined || value === null) {
            if (spec.required) errors.push(`Missing required argument "${field}"`);
            continue;
        }
        if (spec.type && typeof value !== spec.type) {
            errors.push(`Argument "${field}" must be of type ${spec.type}`);
        }
        if (spec.enum && !spec.enum.includes(value)) {
            errors.push(`Argument "${field}" must be one of: ${spec.enum.join(', ')}`);
        }
        if (spec.maxLength && String(value).length > spec.maxLength) {
            errors.push(`Argument "${field}" exceeds max length ${spec.maxLength}`);
        }
    }
    return errors;
}

class ToolExecutionError extends Error {
    constructor(message, code, details = {}) {
        super(message);
        this.code = code;
        this.details = details;
    }
}

class ToolRegistry {
    /**
     * @param {object} deps { policyEngine, rbac, audit, approvalManager, metrics, logger }
     * @param {object} [options] { rateLimiter: {capacity, refillPerSecond},
     *                             circuitBreaker: {failureThreshold, resetTimeoutMs},
     *                             retry: {attempts, baseDelayMs, ...} }
     */
    constructor(deps = {}, options = {}) {
        this.policyEngine = deps.policyEngine || null;
        this.rbac = deps.rbac || null;
        this.audit = deps.audit || null;
        this.approvalManager = deps.approvalManager || null;
        this.metrics = deps.metrics || null;
        this.logger = deps.logger || null;
        this.options = options;
        this.tools = new Map(); // name -> { definition, breaker, limiter }
    }

    register(definition) {
        const { name, handler, riskLevel = 'medium' } = definition;
        if (!name || typeof handler !== 'function') {
            throw new Error('Tool requires a name and a handler function');
        }
        if (!RISK_LEVELS.includes(riskLevel)) {
            throw new Error(`Tool ${name}: invalid riskLevel "${riskLevel}"`);
        }
        if (this.tools.has(name)) {
            throw new Error(`Tool ${name} is already registered`);
        }
        this.tools.set(name, {
            definition: { inputSchema: {}, description: '', ...definition, riskLevel },
            breaker: new CircuitBreaker(this.options.circuitBreaker || {}),
            limiter: new RateLimiter(this.options.rateLimiter || { capacity: 30, refillPerSecond: 5 })
        });
        return this;
    }

    list() {
        return [...this.tools.values()].map(({ definition }) => ({
            name: definition.name,
            description: definition.description,
            riskLevel: definition.riskLevel,
            inputSchema: definition.inputSchema
        }));
    }

    recordAudit(ctx, decision, details) {
        if (this.audit) {
            this.audit.record({
                actor: ctx.agentId || 'unknown',
                action: 'tool.execute',
                decision,
                details: { tool: ctx.tool, ...details }
            });
        }
    }

    count(outcome, tool) {
        if (this.metrics) this.metrics.increment('tool_executions_total', { tool, outcome });
    }

    /**
     * @param {string} name tool name
     * @param {object} args tool arguments
     * @param {object} ctx caller context { agentId, role, taskId, ... }
     */
    async execute(name, args = {}, ctx = {}) {
        const entry = this.tools.get(name);
        const callCtx = { ...ctx, tool: name };
        if (!entry) {
            this.count('unknown_tool', name);
            throw new ToolExecutionError(`Unknown tool: ${name}`, 'UNKNOWN_TOOL');
        }
        const { definition, breaker, limiter } = entry;
        callCtx.riskLevel = definition.riskLevel;

        // 1. Schema validation
        const validationErrors = validateArgs(definition.inputSchema, args);
        if (validationErrors.length) {
            this.count('invalid_args', name);
            throw new ToolExecutionError(
                `Invalid arguments for ${name}: ${validationErrors.join('; ')}`,
                'INVALID_ARGS', { errors: validationErrors }
            );
        }

        // 2. RBAC
        if (this.rbac && ctx.role && !this.rbac.can(ctx.role, `tool:${name}`)) {
            this.recordAudit(callCtx, 'deny', { stage: 'rbac' });
            this.count('rbac_denied', name);
            throw new ToolExecutionError(
                `Role "${ctx.role}" is not permitted to use tool "${name}"`,
                'RBAC_DENIED'
            );
        }

        // 3. Policy
        if (this.policyEngine) {
            const verdict = this.policyEngine.evaluate({ ...callCtx, args });
            if (verdict.decision === 'deny') {
                this.recordAudit(callCtx, 'deny', { stage: 'policy', reason: verdict.reason });
                this.count('policy_denied', name);
                throw new ToolExecutionError(
                    `Policy denied tool "${name}": ${verdict.reason}`,
                    'POLICY_DENIED', { rule: verdict.rule ? verdict.rule.id : null }
                );
            }
            // 4. Human approval
            if (verdict.decision === 'require_approval') {
                if (!this.approvalManager) {
                    this.recordAudit(callCtx, 'deny', { stage: 'approval', reason: 'no approval channel' });
                    this.count('approval_unavailable', name);
                    throw new ToolExecutionError(
                        `Tool "${name}" requires approval but no approval channel is configured`,
                        'APPROVAL_UNAVAILABLE'
                    );
                }
                const { approved, approver, reason } =
                    await this.approvalManager.requestApproval({ ...callCtx, args });
                if (!approved) {
                    this.count('approval_denied', name);
                    throw new ToolExecutionError(
                        `Tool "${name}" was not approved: ${reason}`,
                        'APPROVAL_DENIED', { approver }
                    );
                }
            }
        }

        // 5. Rate limit
        if (!limiter.tryAcquire()) {
            this.count('rate_limited', name);
            throw new ToolExecutionError(`Tool "${name}" is rate limited`, 'RATE_LIMITED');
        }

        // 5b. Circuit breaker + retry + tool-level timeout around the handler
        const timeoutMs = definition.timeoutMs || this.options.timeoutMs || 30000;
        const start = Date.now();
        try {
            const result = await breaker.execute(() =>
                retry(() => withTimeout(() => definition.handler(args, callCtx), timeoutMs, `tool "${name}"`), {
                    attempts: 1, // per-tool retries are opt-in
                    ...this.options.retry
                })
            );
            this.recordAudit(callCtx, 'allow', { stage: 'executed', durationMs: Date.now() - start });
            this.count('success', name);
            if (this.metrics) this.metrics.observe('tool_duration_ms', Date.now() - start, { tool: name });
            return result;
        } catch (err) {
            this.recordAudit(callCtx, 'error', { stage: 'executed', error: err.message });
            this.count('error', name);
            if (this.logger) this.logger.error('Tool execution failed', { tool: name, error: err.message });
            throw err;
        }
    }
}

module.exports = { ToolRegistry, ToolExecutionError, validateArgs, RISK_LEVELS };
