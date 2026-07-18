'use strict';

/**
 * Self-Healing Router — deterministic recovery before LLM escalation.
 *
 * The tool-use plan is a cost-weighted directed graph. Routine failures are
 * handled by marking the failed edge unusable (cost = Infinity) and
 * recomputing the shortest path with Dijkstra — microseconds, no model call.
 * The LLM escalation callback fires only when no feasible path remains,
 * keeping the control plane cheap and loop-free.
 */

class SelfHealingRouter {
    /**
     * @param {object} [options]
     * @param {function} [options.onEscalate] async ({start, goal, reason}) => fallback plan|null
     * @param {object} [options.metrics] MetricsRegistry
     * @param {object} [options.logger]
     */
    constructor(options = {}) {
        this.edges = new Map();    // from -> Map(to -> { cost, tool, failed })
        this.onEscalate = options.onEscalate || null;
        this.metrics = options.metrics || null;
        this.logger = options.logger || null;
        this.stats = { reroutes: 0, escalations: 0, plans: 0 };
    }

    addEdge(from, to, { cost = 1, tool = null } = {}) {
        if (!this.edges.has(from)) this.edges.set(from, new Map());
        this.edges.get(from).set(to, { cost, tool, failed: false });
        if (!this.edges.has(to)) this.edges.set(to, new Map());
        return this;
    }

    markFailed(from, to) {
        const edge = this.edges.get(from) && this.edges.get(from).get(to);
        if (edge) edge.failed = true;
        return this;
    }

    markRecovered(from, to) {
        const edge = this.edges.get(from) && this.edges.get(from).get(to);
        if (edge) edge.failed = false;
        return this;
    }

    /** Dijkstra shortest path. Returns null when the goal is unreachable. */
    plan(start, goal) {
        this.stats.plans += 1;
        const dist = new Map([[start, 0]]);
        const prev = new Map();
        const visited = new Set();
        const frontier = new Set([start]);

        while (frontier.size) {
            let node = null;
            for (const candidate of frontier) {
                if (node === null || dist.get(candidate) < dist.get(node)) node = candidate;
            }
            frontier.delete(node);
            if (node === goal) break;
            visited.add(node);

            for (const [next, edge] of this.edges.get(node) || []) {
                if (edge.failed || visited.has(next)) continue;
                const alt = dist.get(node) + edge.cost;
                if (alt < (dist.has(next) ? dist.get(next) : Infinity)) {
                    dist.set(next, alt);
                    prev.set(next, node);
                    frontier.add(next);
                }
            }
        }

        if (!dist.has(goal)) return null;
        const path = [goal];
        while (path[0] !== start) path.unshift(prev.get(path[0]));
        const steps = [];
        for (let i = 0; i < path.length - 1; i++) {
            const edge = this.edges.get(path[i]).get(path[i + 1]);
            steps.push({ from: path[i], to: path[i + 1], tool: edge.tool, cost: edge.cost });
        }
        return { path, steps, cost: dist.get(goal) };
    }

    /**
     * Executes a route step-by-step. When a step fails, the edge is disabled
     * and the remaining route is recomputed deterministically. Escalates to
     * the LLM callback only when no path remains.
     *
     * @param {string} start
     * @param {string} goal
     * @param {function} executeStep async ({from, to, tool}) => result (throw = failure)
     */
    async executeRoute(start, goal, executeStep) {
        const results = [];
        let position = start;
        for (;;) {
            const route = this.plan(position, goal);
            if (!route) {
                this.stats.escalations += 1;
                if (this.metrics) this.metrics.increment('router_escalations_total');
                if (this.logger) this.logger.warn('Router escalating: no feasible path', { position, goal });
                if (this.onEscalate) {
                    const fallback = await this.onEscalate({ start: position, goal, reason: 'no_feasible_path' });
                    return { status: 'escalated', results, fallback };
                }
                return { status: 'unreachable', results, fallback: null };
            }
            let advanced = true;
            for (const step of route.steps) {
                try {
                    results.push({ step, result: await executeStep(step) });
                    position = step.to;
                } catch (err) {
                    this.markFailed(step.from, step.to);
                    this.stats.reroutes += 1;
                    if (this.metrics) this.metrics.increment('router_reroutes_total');
                    advanced = false;
                    break; // replan from current position
                }
            }
            if (advanced && position === goal) return { status: 'completed', results, fallback: null };
        }
    }
}

/**
 * Attention Monitoring Layer — cheap, non-LLM signal triage. Regex or
 * predicate matchers assign priority scores to runtime events; the highest
 * priority signal wins so urgent conditions preempt routine intent.
 */
class AttentionMonitor {
    constructor() {
        this.signals = []; // { id, match: RegExp|fn, priority }
    }

    addSignal({ id, match, priority = 0.5 }) {
        if (!id || match === undefined) throw new Error('Signal requires id and match');
        this.signals.push({ id, match, priority });
        this.signals.sort((a, b) => b.priority - a.priority);
        return this;
    }

    /** @returns matched signals, highest priority first */
    evaluate(event) {
        const text = typeof event === 'string' ? event : JSON.stringify(event);
        return this.signals.filter(s =>
            s.match instanceof RegExp ? s.match.test(text) : Boolean(s.match(event))
        );
    }

    /** @returns the single top-priority signal or null */
    triage(event) {
        const matches = this.evaluate(event);
        return matches.length ? matches[0] : null;
    }
}

module.exports = { SelfHealingRouter, AttentionMonitor };
