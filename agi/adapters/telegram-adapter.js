'use strict';

/**
 * Telegram channel adapter — connects the existing Telegram bot to the AGI
 * runtime. The bot instance is injected (any object with sendMessage), so
 * this module has no dependency on node-telegram-bot-api itself.
 *
 * Responsibilities:
 *  - route authenticated chat messages into orchestrator tasks
 *  - surface approval requests in chat and accept /approve /deny commands
 *  - report task completion/failure back to the requesting chat
 */

class TelegramAdapter {
    /**
     * @param {object} options
     * @param {object} options.bot Telegram bot (needs sendMessage(chatId, text, opts))
     * @param {object} options.runtime AGI runtime from createRuntime()
     * @param {string} [options.capability] default capability tag for routed tasks
     * @param {number[]} [options.operatorChatIds] chats allowed to approve actions
     */
    constructor(options) {
        if (!options || !options.bot || !options.runtime) {
            throw new Error('TelegramAdapter requires bot and runtime');
        }
        this.bot = options.bot;
        this.runtime = options.runtime;
        this.capability = options.capability || null;
        this.operatorChatIds = options.operatorChatIds || [];

        // Surface approval requests to operators.
        this.runtime.approvals.onRequest = ({ id, ctx }) => this.notifyApproval(id, ctx);
    }

    async notifyApproval(id, ctx) {
        const text =
            `🛂 *Approval required*\n\n` +
            `Agent: \`${ctx.agentId}\`\n` +
            `Tool: \`${ctx.tool}\` (risk: ${ctx.riskLevel})\n\n` +
            `Reply \`/approve ${id}\` or \`/deny ${id}\``;
        for (const chatId of this.operatorChatIds) {
            try {
                await this.bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
            } catch (err) {
                this.runtime.logger.error('Failed to notify operator', { chatId, error: err.message });
            }
        }
    }

    isOperator(chatId) {
        return this.operatorChatIds.includes(chatId);
    }

    /**
     * Handles a chat message. Returns true when the message was consumed
     * (approval command or routed task), false when the caller should
     * handle it through its legacy path.
     */
    async handleMessage(msg) {
        const chatId = msg.chat.id;
        const text = (msg.text || '').trim();
        if (!text) return false;

        const approvalMatch = text.match(/^\/(approve|deny)\s+([a-f0-9]+)/i);
        if (approvalMatch) {
            if (!this.isOperator(chatId)) {
                await this.bot.sendMessage(chatId, '⛔ You are not authorized to approve actions.');
                return true;
            }
            const [, verb, id] = approvalMatch;
            const ok = verb.toLowerCase() === 'approve'
                ? this.runtime.approvals.approve(id, `telegram:${chatId}`)
                : this.runtime.approvals.deny(id, `telegram:${chatId}`);
            await this.bot.sendMessage(
                chatId,
                ok ? `✅ Recorded: ${verb} ${id}` : `⚠️ No pending approval with id \`${id}\``,
                { parse_mode: 'Markdown' }
            );
            return true;
        }

        if (text.startsWith('/agihealth')) {
            const health = this.runtime.health();
            await this.bot.sendMessage(
                chatId,
                `🩺 *Runtime health*\n\`\`\`\n${JSON.stringify(health.orchestrator, null, 2)}\n\`\`\`\n` +
                `Audit chain valid: ${health.auditChain.valid}\n` +
                `Pending approvals: ${health.pendingApprovals}`,
                { parse_mode: 'Markdown' }
            );
            return true;
        }

        if (text.startsWith('/')) return false; // other commands handled by legacy bot

        // Route as an orchestrated task.
        this.runtime.memory.working.add('user', text);
        let submission;
        try {
            submission = this.runtime.orchestrator.submitTask({
                description: text,
                capability: this.capability,
                requestedBy: `telegram:${chatId}`
            });
        } catch (err) {
            await this.bot.sendMessage(chatId, `❌ Could not queue task: ${err.message}`);
            return true;
        }

        await this.bot.sendMessage(
            chatId,
            `⚙️ Task \`${submission.taskId}\` queued.`,
            { parse_mode: 'Markdown' }
        );

        submission.done.then(async (result) => {
            this.runtime.memory.working.add('assistant', result.output || '');
            const icon = result.status === 'completed' ? '✅' : '⚠️';
            await this.bot.sendMessage(
                chatId,
                `${icon} *Task ${submission.taskId} ${result.status}*\n\n${(result.output || '').slice(0, 3500)}`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        });
        return true;
    }
}

module.exports = { TelegramAdapter };
