'use strict';

/**
 * Human-in-the-loop approval workflow.
 *
 * When the policy engine returns "require_approval", the runtime parks the
 * action here and notifies operators (e.g. via Telegram). The action resumes
 * only when an authorized human approves it, and expires otherwise.
 */

const crypto = require('crypto');

class ApprovalManager {
    /**
     * @param {object} [options]
     * @param {number} [options.timeoutMs] auto-deny after this long (default 5 min)
     * @param {object} [options.audit] AuditLog instance
     * @param {function} [options.onRequest] async ({id, ctx}) => void — notify operators
     */
    constructor(options = {}) {
        this.timeoutMs = options.timeoutMs || 5 * 60 * 1000;
        this.audit = options.audit || null;
        this.onRequest = options.onRequest || null;
        this.pending = new Map(); // id -> { ctx, resolve, timer, requestedAt }
    }

    /**
     * @param {object} ctx action context (agentId, tool, args, riskLevel, ...)
     * @returns {Promise<{approved: boolean, approver: string|null, reason: string}>}
     */
    async requestApproval(ctx) {
        const id = crypto.randomBytes(6).toString('hex');
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.settle(id, false, 'system', 'Approval request timed out');
            }, this.timeoutMs);
            this.pending.set(id, { ctx, resolve, timer, requestedAt: Date.now() });
            if (this.audit) {
                this.audit.record({
                    actor: ctx.agentId || 'unknown',
                    action: 'approval.requested',
                    details: { approvalId: id, tool: ctx.tool, riskLevel: ctx.riskLevel }
                });
            }
            if (this.onRequest) {
                Promise.resolve(this.onRequest({ id, ctx })).catch(() => {});
            }
        });
    }

    settle(id, approved, approver, reason) {
        const req = this.pending.get(id);
        if (!req) return false;
        clearTimeout(req.timer);
        this.pending.delete(id);
        if (this.audit) {
            this.audit.record({
                actor: approver,
                action: approved ? 'approval.granted' : 'approval.denied',
                decision: approved ? 'allow' : 'deny',
                details: { approvalId: id, tool: req.ctx.tool, reason }
            });
        }
        req.resolve({ approved, approver, reason });
        return true;
    }

    approve(id, approver = 'operator') {
        return this.settle(id, true, approver, 'Approved by operator');
    }

    deny(id, approver = 'operator', reason = 'Denied by operator') {
        return this.settle(id, false, approver, reason);
    }

    listPending() {
        return [...this.pending.entries()].map(([id, req]) => ({
            id,
            tool: req.ctx.tool,
            agentId: req.ctx.agentId,
            riskLevel: req.ctx.riskLevel,
            requestedAt: req.requestedAt
        }));
    }
}

module.exports = { ApprovalManager };
