'use strict';

/**
 * Companion runtime (VIGIL-style) — cross-session maintenance plane.
 *
 * Runs beside task execution, never inside it. It appraises structured
 * runtime events into a bounded signal bank, tracks behavioral drift across
 * episodes (error-rate and latency trends that single-session monitors
 * cannot see), produces Roses/Buds/Thorns diagnostics, and emits remediation
 * *proposals* into the guarded evolution engine. It has no authority to
 * commit anything — diagnosis and commit stay in separate planes.
 */

class CompanionRuntime {
    /**
     * @param {object} deps { eventBus, logger, metrics }
     * @param {object} [options]
     * @param {number} [options.maxAppraisals] bounded bank size (default 2000)
     * @param {number} [options.driftWindow] appraisals per drift comparison half (default 20)
     * @param {number} [options.thornThreshold] recurrences before a cause is a thorn (default 2)
     */
    constructor(deps = {}, options = {}) {
        this.logger = deps.logger || null;
        this.metrics = deps.metrics || null;
        this.maxAppraisals = options.maxAppraisals || 2000;
        this.driftWindow = options.driftWindow || 20;
        this.thornThreshold = options.thornThreshold || 2;
        this.appraisals = []; // the signal bank
        if (deps.eventBus) this.attach(deps.eventBus);
    }

    attach(eventBus) {
        eventBus.subscribe('task.completed', (payload) => this.ingest({
            cause: 'task.completed',
            success: true,
            episode: payload.taskId,
            durationMs: payload.durationMs
        }));
        eventBus.subscribe('task.failed', (payload) => this.ingest({
            cause: (payload.result && payload.result.output) || 'task.failed',
            success: false,
            episode: payload.taskId
        }));
        return this;
    }

    /**
     * Appraises a runtime event into a structured signal.
     * @param {object} event { cause, success, durationMs?, episode?, severity? }
     */
    ingest(event) {
        const severity = event.severity !== undefined
            ? event.severity
            : (event.success ? 0.2 : 0.75);
        const appraisal = {
            ts: new Date().toISOString(),
            emotion: event.success ? 'satisfaction' : 'frustration',
            intensity: severity,
            valence: event.success ? severity : -severity,
            cause: String(event.cause || 'unknown').slice(0, 200),
            episode: event.episode || null,
            durationMs: event.durationMs || null
        };
        this.appraisals.push(appraisal);
        if (this.appraisals.length > this.maxAppraisals) this.appraisals.shift();
        if (this.metrics) {
            this.metrics.increment('companion_appraisals_total', {
                emotion: appraisal.emotion
            });
        }
        return appraisal;
    }

    /**
     * Compares the older half of the recent window against the newer half to
     * surface drift a per-session monitor would miss.
     */
    driftReport() {
        const window = this.appraisals.slice(-this.driftWindow * 2);
        if (window.length < 4) {
            return { sufficientData: false, drifting: false };
        }
        const mid = Math.floor(window.length / 2);
        const stats = (slice) => {
            const failures = slice.filter(a => a.valence < 0).length;
            const durations = slice.map(a => a.durationMs).filter(d => d !== null);
            return {
                errorRate: failures / slice.length,
                avgDurationMs: durations.length
                    ? durations.reduce((a, b) => a + b, 0) / durations.length
                    : null
            };
        };
        const before = stats(window.slice(0, mid));
        const after = stats(window.slice(mid));
        const errorRateDelta = after.errorRate - before.errorRate;
        const latencyDelta = (before.avgDurationMs !== null && after.avgDurationMs !== null)
            ? after.avgDurationMs - before.avgDurationMs
            : null;
        return {
            sufficientData: true,
            before,
            after,
            errorRateDelta,
            latencyDelta,
            drifting: errorRateDelta > 0.2 || (latencyDelta !== null && before.avgDurationMs > 0 && latencyDelta / before.avgDurationMs > 0.5)
        };
    }

    /** Roses/Buds/Thorns diagnostic artifact. */
    report() {
        const byCause = new Map();
        for (const a of this.appraisals) {
            if (!byCause.has(a.cause)) byCause.set(a.cause, { cause: a.cause, positive: 0, negative: 0 });
            const c = byCause.get(a.cause);
            if (a.valence >= 0) c.positive += 1; else c.negative += 1;
        }
        const causes = [...byCause.values()];
        return {
            generatedAt: new Date().toISOString(),
            appraisalCount: this.appraisals.length,
            roses: causes.filter(c => c.positive > 0 && c.negative === 0)
                .sort((a, b) => b.positive - a.positive).slice(0, 5),
            buds: causes.filter(c => c.positive > 0 && c.negative > 0)
                .sort((a, b) => b.negative - a.negative).slice(0, 5),
            thorns: causes.filter(c => c.negative >= this.thornThreshold)
                .sort((a, b) => b.negative - a.negative).slice(0, 5),
            drift: this.driftReport()
        };
    }

    /**
     * Turns thorns into guarded evolution proposals (adaptive prompt guidance).
     * The companion only proposes; evaluation, policy and human approval
     * still gate every commit.
     */
    proposeRemediations(evolutionEngine) {
        const { thorns } = this.report();
        const proposals = [];
        for (const thorn of thorns) {
            try {
                proposals.push(evolutionEngine.propose({
                    kind: 'prompt',
                    target: 'adaptive.reliability-guidance',
                    content:
                        `Known recurring failure (${thorn.negative}x): "${thorn.cause}". ` +
                        'Prefer alternative approaches, validate preconditions first, and fail fast instead of retrying blindly.',
                    rationale: `Companion runtime detected recurring failure: ${thorn.cause}`,
                    proposedBy: 'companion-runtime'
                }));
            } catch (err) {
                if (this.logger) {
                    this.logger.warn('Remediation proposal rejected', { cause: thorn.cause, error: err.message });
                }
            }
        }
        return proposals;
    }
}

module.exports = { CompanionRuntime };
