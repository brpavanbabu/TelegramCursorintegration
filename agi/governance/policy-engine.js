'use strict';

/**
 * Declarative policy (rules) engine — the governance heart of the runtime.
 *
 * Every action an agent wants to take is described by a context object and
 * evaluated against an ordered rule set. The engine is default-deny: if no
 * rule matches, the action is refused. Effects, from most to least
 * restrictive: deny > require_approval > allow. When several rules share the
 * highest priority, the most restrictive effect wins.
 *
 * Rule shape:
 *   {
 *     id: 'deny-destructive-shell',
 *     description: 'Block destructive shell commands',
 *     priority: 100,                       // higher evaluates first
 *     match: {
 *       tool: 'shell.*',                   // glob on ctx.tool
 *       riskLevel: ['high', 'critical'],   // any-of on ctx.riskLevel
 *       role: (role) => role !== 'admin'   // predicate
 *     },
 *     effect: 'deny'                       // allow | deny | require_approval
 *   }
 */

const EFFECTS = ['allow', 'deny', 'require_approval'];
const RESTRICTIVENESS = { deny: 3, require_approval: 2, allow: 1 };

function globToRegExp(glob) {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
}

function matchValue(expected, actual) {
    if (typeof expected === 'function') {
        // A predicate that throws must not crash evaluation; treat as no-match
        // so the engine's default-deny still applies rather than an exception.
        try {
            return Boolean(expected(actual));
        } catch (err) {
            return false;
        }
    }
    if (Array.isArray(expected)) return expected.some(e => matchValue(e, actual));
    if (typeof expected === 'string' && expected.includes('*')) {
        return globToRegExp(expected).test(String(actual));
    }
    return expected === actual;
}

class PolicyEngine {
    /**
     * @param {object} [options]
     * @param {Array}  [options.rules] initial rule set
     * @param {string} [options.defaultEffect] effect when nothing matches (default 'deny')
     * @param {object} [options.audit] AuditLog instance to record decisions
     */
    constructor(options = {}) {
        this.rules = [];
        this.defaultEffect = options.defaultEffect || 'deny';
        this.audit = options.audit || null;
        (options.rules || []).forEach(rule => this.addRule(rule));
    }

    addRule(rule) {
        if (!rule.id) throw new Error('Policy rule requires an id');
        if (!EFFECTS.includes(rule.effect)) {
            throw new Error(`Policy rule ${rule.id}: invalid effect "${rule.effect}"`);
        }
        if (this.rules.some(r => r.id === rule.id)) {
            throw new Error(`Policy rule ${rule.id}: duplicate id`);
        }
        this.rules.push({ priority: 0, match: {}, ...rule });
        this.rules.sort((a, b) => b.priority - a.priority);
        return this;
    }

    removeRule(id) {
        this.rules = this.rules.filter(r => r.id !== id);
        return this;
    }

    ruleMatches(rule, ctx) {
        return Object.entries(rule.match).every(
            ([field, expected]) => matchValue(expected, ctx[field])
        );
    }

    /**
     * @param {object} ctx e.g. { agentId, role, tool, action, riskLevel, args }
     * @returns {{decision: string, rule: object|null, reason: string}}
     */
    evaluate(ctx) {
        const matched = this.rules.filter(rule => this.ruleMatches(rule, ctx));
        let result;
        if (matched.length === 0) {
            result = {
                decision: this.defaultEffect,
                rule: null,
                reason: `No policy rule matched; default effect is "${this.defaultEffect}"`
            };
        } else {
            const topPriority = matched[0].priority;
            const winner = matched
                .filter(r => r.priority === topPriority)
                .sort((a, b) => RESTRICTIVENESS[b.effect] - RESTRICTIVENESS[a.effect])[0];
            result = {
                decision: winner.effect,
                rule: winner,
                reason: winner.description || `Matched rule "${winner.id}"`
            };
        }
        if (this.audit) {
            this.audit.record({
                actor: ctx.agentId || 'unknown',
                action: 'policy.evaluate',
                decision: result.decision,
                details: {
                    tool: ctx.tool,
                    riskLevel: ctx.riskLevel,
                    ruleId: result.rule ? result.rule.id : null
                }
            });
        }
        return result;
    }
}

module.exports = { PolicyEngine, EFFECTS };
