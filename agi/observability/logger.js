'use strict';

/**
 * Structured JSON logger with secret redaction.
 *
 * Every log line is a single JSON object so it can be shipped straight to
 * an aggregator (CloudWatch, Datadog, ELK) without extra parsing.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const DEFAULT_REDACT_KEYS = [
    'password', 'token', 'apikey', 'api_key', 'secret', 'authorization',
    'telegrambottoken', 'credential', 'privatekey', 'private_key'
];

function redactValue(key, value, redactKeys) {
    if (typeof key === 'string' && redactKeys.includes(key.toLowerCase())) {
        return '[REDACTED]';
    }
    return value;
}

function deepRedact(obj, redactKeys, depth = 0) {
    if (depth > 8 || obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(v => deepRedact(v, redactKeys, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        const redacted = redactValue(k, v, redactKeys);
        out[k] = redacted === '[REDACTED]' ? redacted : deepRedact(v, redactKeys, depth + 1);
    }
    return out;
}

class Logger {
    /**
     * @param {object} [options]
     * @param {string} [options.level] minimum level: debug|info|warn|error
     * @param {string} [options.service] service name stamped on every line
     * @param {string[]} [options.redactKeys] extra keys to redact
     * @param {function} [options.sink] receives the final JSON string (default: console)
     */
    constructor(options = {}) {
        this.level = options.level || 'info';
        this.service = options.service || 'agi-runtime';
        this.redactKeys = DEFAULT_REDACT_KEYS.concat(
            (options.redactKeys || []).map(k => k.toLowerCase())
        );
        this.sink = options.sink || ((line) => console.log(line));
        this.context = options.context || {};
    }

    child(context) {
        return new Logger({
            level: this.level,
            service: this.service,
            redactKeys: this.redactKeys,
            sink: this.sink,
            context: { ...this.context, ...context }
        });
    }

    log(level, message, fields = {}) {
        if (LEVELS[level] < LEVELS[this.level]) return;
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            service: this.service,
            message,
            ...deepRedact({ ...this.context, ...fields }, this.redactKeys)
        };
        this.sink(JSON.stringify(entry));
    }

    debug(message, fields) { this.log('debug', message, fields); }
    info(message, fields) { this.log('info', message, fields); }
    warn(message, fields) { this.log('warn', message, fields); }
    error(message, fields) { this.log('error', message, fields); }
}

module.exports = { Logger, deepRedact, DEFAULT_REDACT_KEYS };
