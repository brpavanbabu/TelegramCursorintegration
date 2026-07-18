'use strict';

/**
 * Tamper-evident audit trail.
 *
 * Every entry is hash-chained to its predecessor (like a mini blockchain):
 * altering any historic entry breaks verification of every later hash.
 * Optionally persists as append-only JSONL for compliance retention.
 */

const crypto = require('crypto');
const fs = require('fs');

class AuditLog {
    /**
     * @param {object} [options]
     * @param {string} [options.filePath] append entries as JSONL to this file
     * @param {number} [options.maxInMemory] bounded in-memory window (default 10000)
     * @param {function} [options.clock] returns ISO timestamp (injectable for tests)
     */
    constructor(options = {}) {
        this.entries = [];
        this.filePath = options.filePath || null;
        this.maxInMemory = options.maxInMemory || 10000;
        this.clock = options.clock || (() => new Date().toISOString());
        this.lastHash = 'GENESIS';
        this.seq = 0;
    }

    static hashEntry(entry) {
        return crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex');
    }

    /**
     * @param {object} event { actor, action, decision?, details? }
     * @returns {object} the recorded entry, including its hash
     */
    record(event) {
        if (!event || !event.actor || !event.action) {
            throw new Error('Audit entry requires actor and action');
        }
        const body = {
            seq: ++this.seq,
            timestamp: this.clock(),
            actor: event.actor,
            action: event.action,
            decision: event.decision || null,
            details: event.details || {},
            prevHash: this.lastHash
        };
        const entry = { ...body, hash: AuditLog.hashEntry(body) };
        this.lastHash = entry.hash;

        this.entries.push(entry);
        if (this.entries.length > this.maxInMemory) {
            this.entries.shift(); // file (if configured) retains the full history
        }
        if (this.filePath) {
            fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
        }
        return entry;
    }

    /**
     * Verifies the hash chain of the given entries (defaults to in-memory window).
     * @returns {{valid: boolean, brokenAt: number|null}}
     */
    verify(entries = this.entries) {
        let prevHash = entries.length ? entries[0].prevHash : 'GENESIS';
        for (const entry of entries) {
            const { hash, ...body } = entry;
            if (body.prevHash !== prevHash || AuditLog.hashEntry(body) !== hash) {
                return { valid: false, brokenAt: entry.seq };
            }
            prevHash = hash;
        }
        return { valid: true, brokenAt: null };
    }

    query({ actor, action, decision, limit = 100 } = {}) {
        return this.entries
            .filter(e =>
                (!actor || e.actor === actor) &&
                (!action || e.action === action || e.action.startsWith(action + '.')) &&
                (!decision || e.decision === decision))
            .slice(-limit);
    }
}

module.exports = { AuditLog };
