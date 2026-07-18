'use strict';

/**
 * Enterprise AGI runtime factory.
 *
 * Wires the full stack — config, observability, governance (policy engine,
 * RBAC, audit, approvals), memory, governed tools, providers and the
 * multi-agent orchestrator — into one runtime object:
 *
 *   const { createRuntime } = require('./agi');
 *   const runtime = createRuntime({ provider: { kind: 'anthropic' } });
 *   runtime.rbac.defineRole('builder', ['tool:workspace.*']);
 *   runtime.tools.register({ name: 'workspace.list', riskLevel: 'low', handler: ... });
 *   runtime.createAgent({ id: 'coder', role: 'builder', capabilities: ['code'] });
 *   const { done } = runtime.orchestrator.submitTask({ description: '...', capability: 'code' });
 */

const { loadConfig } = require('./config/config');
const { Logger } = require('./observability/logger');
const { MetricsRegistry } = require('./observability/metrics');
const { EventBus } = require('./core/event-bus');
const { AuditLog } = require('./governance/audit-log');
const { PolicyEngine } = require('./governance/policy-engine');
const { DEFAULT_POLICIES } = require('./governance/default-policies');
const { RBAC } = require('./governance/rbac');
const { ApprovalManager } = require('./governance/approval-manager');
const { MemoryManager } = require('./memory/memory-manager');
const { ToolRegistry } = require('./tools/tool-registry');
const { Provider, AnthropicProvider, MockProvider } = require('./providers');
const { Agent } = require('./core/agent');
const { Orchestrator } = require('./core/orchestrator');
const { SelfHealingRouter, AttentionMonitor } = require('./routing/self-healing-router');
const { EvolutionEngine } = require('./evolution/evolution-engine');
const { CompanionRuntime } = require('./monitoring/companion-runtime');
const { EgressPolicy, WorkspaceBoundary, withTimeout } = require('./security/execution-boundaries');

function createProvider(config, override) {
    if (override) return override;
    if (config.provider.kind === 'anthropic') {
        return new AnthropicProvider({ model: config.provider.model });
    }
    return new MockProvider();
}

/**
 * @param {object} [configOverrides] partial config (see agi/config/config.js)
 * @param {object} [deps] injectable dependencies { provider, logger, onApprovalRequest }
 * @returns runtime with { config, logger, metrics, eventBus, audit, policyEngine,
 *          rbac, approvals, memory, tools, provider, orchestrator, createAgent, shutdown }
 */
function createRuntime(configOverrides = {}, deps = {}) {
    const config = loadConfig(configOverrides);
    const logger = deps.logger || new Logger({ level: config.logLevel, service: config.service });
    const metrics = new MetricsRegistry();
    const eventBus = new EventBus({
        onError: (err, topic) => logger.error('Event handler failed', { topic, error: err.message })
    });

    const audit = new AuditLog({
        filePath: config.audit.filePath,
        maxInMemory: config.audit.maxInMemory
    });
    const policyEngine = new PolicyEngine({
        rules: DEFAULT_POLICIES,
        defaultEffect: 'deny',
        audit
    });
    const rbac = new RBAC();
    const approvals = new ApprovalManager({
        timeoutMs: config.approvals.timeoutMs,
        audit,
        onRequest: deps.onApprovalRequest || null
    });
    const memory = new MemoryManager(config.memory);
    const tools = new ToolRegistry(
        { policyEngine, rbac, audit, approvalManager: approvals, metrics, logger },
        config.tools
    );
    const provider = createProvider(config, deps.provider);
    const orchestrator = new Orchestrator(
        { eventBus, audit, metrics, logger },
        config.orchestrator
    );

    // Deterministic control plane: graph routing + cheap signal triage,
    // with the LLM reserved for genuine no-path escalations.
    const router = new SelfHealingRouter({
        metrics,
        logger,
        onEscalate: deps.onRouterEscalate || null
    });
    const attention = new AttentionMonitor();

    // Guarded self-evolution: proposals from anywhere, commits only through
    // threat scan -> independent evaluation -> policy -> human approval.
    const evolution = new EvolutionEngine(
        { policyEngine, approvalManager: approvals, audit, memory, logger, metrics },
        config.evolution
    );

    // Maintenance plane: cross-session drift detection and RBT diagnostics.
    const companion = new CompanionRuntime({ eventBus, logger, metrics });

    // Blast-radius controls: default-deny egress.
    const egress = new EgressPolicy({ allow: config.egress.allow, audit });

    function createAgent(options) {
        const agent = new Agent({
            maxSteps: config.agentDefaults.maxSteps,
            maxDurationMs: config.agentDefaults.maxDurationMs,
            provider,
            toolRegistry: tools,
            memory,
            promptSections: evolution.promptSections,
            logger: logger.child({ agentId: options.id }),
            metrics,
            ...options
        });
        orchestrator.registerAgent(agent);
        return agent;
    }

    return {
        config,
        logger,
        metrics,
        eventBus,
        audit,
        policyEngine,
        rbac,
        approvals,
        memory,
        tools,
        provider,
        orchestrator,
        router,
        attention,
        evolution,
        companion,
        egress,
        createAgent,
        /** Health/compliance snapshot for dashboards and readiness probes. */
        health() {
            return {
                status: 'ok',
                orchestrator: orchestrator.stats(),
                pendingApprovals: approvals.listPending().length,
                auditChain: audit.verify(),
                evolutionLineage: evolution.verifyLineage(),
                generation: evolution.generation,
                router: router.stats,
                drift: companion.driftReport(),
                metrics: metrics.snapshot()
            };
        }
    };
}

module.exports = {
    createRuntime,
    // Re-export building blocks for advanced composition:
    Agent, Orchestrator, PolicyEngine, RBAC, AuditLog, ApprovalManager,
    MemoryManager, ToolRegistry, Provider, AnthropicProvider, MockProvider,
    Logger, MetricsRegistry, EventBus, DEFAULT_POLICIES,
    SelfHealingRouter, AttentionMonitor, EvolutionEngine, CompanionRuntime,
    EgressPolicy, WorkspaceBoundary, withTimeout
};
