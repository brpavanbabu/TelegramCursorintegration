'use strict';

/**
 * Execution boundaries — blast-radius controls for autonomous operation.
 *
 * In-process enforcement of the sandbox policies that don't need a container:
 *  - multi-level timeouts (tool-level here; loop-level lives in Agent)
 *  - default-deny network egress with an explicit hostname allowlist
 *  - workspace path confinement for file-touching tools
 *
 * OS-level isolation (non-root containers, read-only mounts, Firecrawl-style
 * lockdown) is a deployment concern — see docs/SELF_EVOLUTION.md — but these
 * guards hold even when the process runs outside a container.
 */

const path = require('path');

class TimeoutError extends Error {
    constructor(label, ms) {
        super(`${label} timed out after ${ms}ms`);
        this.code = 'TIMEOUT';
    }
}

/** Rejects with TimeoutError when fn doesn't settle within ms. */
async function withTimeout(fn, ms, label = 'operation') {
    let timer;
    try {
        return await Promise.race([
            fn(),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Default-deny egress policy. Hostnames must be explicitly allowlisted;
 * subdomain wildcards use the "*.example.com" form.
 */
class EgressPolicy {
    constructor(options = {}) {
        this.allow = options.allow || [];
        this.audit = options.audit || null;
    }

    isAllowed(url) {
        let hostname;
        try {
            hostname = new URL(url).hostname.toLowerCase();
        } catch (err) {
            return false;
        }
        return this.allow.some(entry => {
            const rule = entry.toLowerCase();
            if (rule.startsWith('*.')) {
                const suffix = rule.slice(1); // ".example.com"
                return hostname.endsWith(suffix) && hostname.length > suffix.length;
            }
            return hostname === rule;
        });
    }

    /** fetch wrapper that enforces the allowlist and audits blocks. */
    guardedFetch(fetchImpl = globalThis.fetch) {
        return async (url, options = {}) => {
            if (!this.isAllowed(url)) {
                if (this.audit) {
                    this.audit.record({
                        actor: 'egress-policy',
                        action: 'egress.blocked',
                        decision: 'deny',
                        details: { url: String(url).slice(0, 300) }
                    });
                }
                const err = new Error(`Egress blocked: ${url} is not on the allowlist`);
                err.code = 'EGRESS_BLOCKED';
                throw err;
            }
            return fetchImpl(url, options);
        };
    }
}

/**
 * Confines file paths to a workspace root — file-touching tools call this
 * before every read/write so traversal ("../../etc/passwd") cannot escape.
 */
class WorkspaceBoundary {
    constructor(root) {
        if (!root) throw new Error('WorkspaceBoundary requires a root directory');
        this.root = path.resolve(root);
    }

    resolve(candidate) {
        const resolved = path.resolve(this.root, candidate);
        if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
            const err = new Error(`Path escapes workspace boundary: ${candidate}`);
            err.code = 'PATH_ESCAPE';
            throw err;
        }
        return resolved;
    }
}

module.exports = { withTimeout, TimeoutError, EgressPolicy, WorkspaceBoundary };
