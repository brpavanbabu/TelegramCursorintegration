'use strict';

/**
 * Lightweight publish/subscribe bus used to decouple runtime components.
 * Supports exact topics and single-level trailing wildcards ("task.*").
 */

class EventBus {
    constructor(options = {}) {
        this.handlers = new Map(); // topic -> Set<fn>
        this.onError = options.onError || (() => {});
    }

    subscribe(topic, handler) {
        if (!this.handlers.has(topic)) this.handlers.set(topic, new Set());
        this.handlers.get(topic).add(handler);
        return () => this.handlers.get(topic).delete(handler);
    }

    matches(pattern, topic) {
        if (pattern === topic || pattern === '*') return true;
        if (pattern.endsWith('.*')) {
            return topic.startsWith(pattern.slice(0, -1));
        }
        return false;
    }

    async publish(topic, payload) {
        for (const [pattern, handlers] of this.handlers) {
            if (!this.matches(pattern, topic)) continue;
            for (const handler of handlers) {
                try {
                    await handler(payload, topic);
                } catch (err) {
                    this.onError(err, topic);
                }
            }
        }
    }
}

module.exports = { EventBus };
