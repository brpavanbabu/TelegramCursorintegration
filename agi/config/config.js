'use strict';

/**
 * Runtime configuration: defaults <- file/object overrides <- environment.
 * Secrets are only read from the environment, never persisted to disk, and
 * validation fails fast with every problem listed at once.
 */

const DEFAULTS = {
    service: 'agi-runtime',
    logLevel: 'info',
    orchestrator: {
        maxConcurrent: 2,
        maxQueueSize: 100
    },
    agentDefaults: {
        maxSteps: 8,
        maxDurationMs: 20 * 60 * 1000
    },
    approvals: {
        timeoutMs: 5 * 60 * 1000
    },
    memory: {
        workingMaxMessages: 50,
        episodicMaxEpisodes: 1000,
        episodicFilePath: null
    },
    audit: {
        filePath: null,
        maxInMemory: 10000
    },
    tools: {
        rateLimiter: { capacity: 30, refillPerSecond: 5 },
        circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30000 },
        retry: { attempts: 1 },
        timeoutMs: 30000
    },
    evolution: {
        minMutationScore: 0.6,
        propertyRuns: 200,
        protectedTargets: []
    },
    egress: {
        allow: []
    },
    provider: {
        kind: 'mock', // mock | anthropic
        model: 'claude-sonnet-5'
    }
};

const ENV_OVERRIDES = {
    AGI_LOG_LEVEL: ['logLevel'],
    AGI_MAX_CONCURRENT: ['orchestrator', 'maxConcurrent', Number],
    AGI_MAX_QUEUE_SIZE: ['orchestrator', 'maxQueueSize', Number],
    AGI_AGENT_MAX_STEPS: ['agentDefaults', 'maxSteps', Number],
    AGI_AGENT_MAX_DURATION_MS: ['agentDefaults', 'maxDurationMs', Number],
    AGI_TOOL_TIMEOUT_MS: ['tools', 'timeoutMs', Number],
    AGI_MIN_MUTATION_SCORE: ['evolution', 'minMutationScore', Number],
    AGI_APPROVAL_TIMEOUT_MS: ['approvals', 'timeoutMs', Number],
    AGI_AUDIT_FILE: ['audit', 'filePath'],
    AGI_EPISODIC_FILE: ['memory', 'episodicFilePath'],
    AGI_PROVIDER: ['provider', 'kind'],
    AGI_MODEL: ['provider', 'model']
};

function deepMerge(base, override) {
    const out = { ...base };
    for (const [key, value] of Object.entries(override || {})) {
        if (value && typeof value === 'object' && !Array.isArray(value) &&
            base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
            out[key] = deepMerge(base[key], value);
        } else if (value !== undefined) {
            out[key] = value;
        }
    }
    return out;
}

function applyEnv(config, env) {
    for (const [envKey, spec] of Object.entries(ENV_OVERRIDES)) {
        if (env[envKey] === undefined || env[envKey] === '') continue;
        const path = spec.filter(s => typeof s === 'string');
        const cast = spec.find(s => typeof s === 'function') || String;
        let node = config;
        for (const segment of path.slice(0, -1)) node = node[segment];
        node[path[path.length - 1]] = cast(env[envKey]);
    }
    return config;
}

function validate(config) {
    const errors = [];
    if (!['debug', 'info', 'warn', 'error'].includes(config.logLevel)) {
        errors.push(`logLevel must be debug|info|warn|error, got "${config.logLevel}"`);
    }
    if (!(config.orchestrator.maxConcurrent >= 1)) {
        errors.push('orchestrator.maxConcurrent must be >= 1');
    }
    if (!(config.orchestrator.maxQueueSize >= 1)) {
        errors.push('orchestrator.maxQueueSize must be >= 1');
    }
    if (!(config.agentDefaults.maxSteps >= 1 && config.agentDefaults.maxSteps <= 100)) {
        errors.push('agentDefaults.maxSteps must be between 1 and 100');
    }
    if (!(config.agentDefaults.maxDurationMs >= 1000)) {
        errors.push('agentDefaults.maxDurationMs must be >= 1000');
    }
    if (!(config.tools.timeoutMs >= 100)) {
        errors.push('tools.timeoutMs must be >= 100');
    }
    if (!(config.evolution.minMutationScore >= 0 && config.evolution.minMutationScore <= 1)) {
        errors.push('evolution.minMutationScore must be between 0 and 1');
    }
    if (!['mock', 'anthropic'].includes(config.provider.kind)) {
        errors.push(`provider.kind must be mock|anthropic, got "${config.provider.kind}"`);
    }
    if (config.provider.kind === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
        errors.push('provider.kind=anthropic requires the ANTHROPIC_API_KEY environment variable');
    }
    if (errors.length) {
        throw new Error('Invalid configuration:\n- ' + errors.join('\n- '));
    }
    return config;
}

/**
 * @param {object} [overrides] partial config
 * @param {object} [env] environment map (default process.env)
 */
function loadConfig(overrides = {}, env = process.env) {
    return validate(applyEnv(deepMerge(DEFAULTS, overrides), env));
}

module.exports = { loadConfig, DEFAULTS };
