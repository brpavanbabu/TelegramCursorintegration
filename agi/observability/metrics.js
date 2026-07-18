'use strict';

/**
 * In-process metrics registry: counters, gauges and duration histograms.
 * Snapshot output is plain JSON so it can be scraped or pushed to any
 * monitoring backend (Prometheus push-gateway, StatsD bridge, etc.).
 */

class MetricsRegistry {
    constructor() {
        this.counters = new Map();
        this.gauges = new Map();
        this.histograms = new Map();
    }

    static key(name, labels = {}) {
        const parts = Object.keys(labels).sort().map(k => `${k}=${labels[k]}`);
        return parts.length ? `${name}{${parts.join(',')}}` : name;
    }

    increment(name, labels = {}, value = 1) {
        const key = MetricsRegistry.key(name, labels);
        this.counters.set(key, (this.counters.get(key) || 0) + value);
    }

    gauge(name, value, labels = {}) {
        this.gauges.set(MetricsRegistry.key(name, labels), value);
    }

    observe(name, durationMs, labels = {}) {
        const key = MetricsRegistry.key(name, labels);
        if (!this.histograms.has(key)) {
            this.histograms.set(key, { count: 0, sum: 0, min: Infinity, max: -Infinity });
        }
        const h = this.histograms.get(key);
        h.count += 1;
        h.sum += durationMs;
        h.min = Math.min(h.min, durationMs);
        h.max = Math.max(h.max, durationMs);
    }

    /** Times an async function and records its duration + outcome counter. */
    async time(name, labels, fn) {
        const start = Date.now();
        try {
            const result = await fn();
            this.observe(name, Date.now() - start, { ...labels, outcome: 'success' });
            return result;
        } catch (err) {
            this.observe(name, Date.now() - start, { ...labels, outcome: 'error' });
            throw err;
        }
    }

    snapshot() {
        const histograms = {};
        for (const [k, h] of this.histograms) {
            histograms[k] = { ...h, avg: h.count ? h.sum / h.count : 0 };
        }
        return {
            counters: Object.fromEntries(this.counters),
            gauges: Object.fromEntries(this.gauges),
            histograms
        };
    }

    reset() {
        this.counters.clear();
        this.gauges.clear();
        this.histograms.clear();
    }
}

module.exports = { MetricsRegistry };
