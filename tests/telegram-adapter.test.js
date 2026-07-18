'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createRuntime } = require('../agi');
const { MockProvider } = require('../agi/providers');
const { TelegramAdapter } = require('../agi/adapters/telegram-adapter');

function fakeBot() {
    const sent = [];
    return {
        sent,
        async sendMessage(chatId, text, opts) { sent.push({ chatId, text, opts }); }
    };
}

function buildAdapter(responses, options = {}) {
    const runtime = createRuntime({ logLevel: 'error' }, { provider: new MockProvider(responses) });
    runtime.rbac.defineRole('worker', ['tool:*']);
    runtime.createAgent({ id: 'assistant', role: 'worker', capabilities: ['chat'] });
    const bot = fakeBot();
    const adapter = new TelegramAdapter({
        bot, runtime, capability: 'chat', operatorChatIds: [111], ...options
    });
    return { runtime, bot, adapter };
}

test('routes a chat message to the orchestrator and replies with the result', async () => {
    const { bot, adapter, runtime } = buildAdapter(['{"final": "Here is your app"}']);
    const consumed = await adapter.handleMessage({ chat: { id: 42 }, text: 'build me an app' });
    assert.strictEqual(consumed, true);

    // wait for the queued task to finish
    const task = [...runtime.orchestrator.tasks.values()][0];
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(task.status, 'completed');
    assert.ok(bot.sent.some(m => m.text.includes('queued')));
    assert.ok(bot.sent.some(m => m.text.includes('Here is your app')));
});

test('non-operators cannot approve pending actions', async () => {
    const { bot, adapter } = buildAdapter([]);
    const consumed = await adapter.handleMessage({ chat: { id: 999 }, text: '/approve abc123' });
    assert.strictEqual(consumed, true);
    assert.match(bot.sent[0].text, /not authorized/);
});

test('operators can approve a pending high-risk action', async () => {
    const { bot, adapter, runtime } = buildAdapter([]);
    let settled = null;
    const pending = runtime.approvals.requestApproval({
        agentId: 'assistant', tool: 'deploy.prod', riskLevel: 'high'
    }).then(r => { settled = r; });

    await new Promise(r => setImmediate(r));
    // adapter's onRequest hook should have notified the operator chat
    const notice = bot.sent.find(m => m.chatId === 111 && m.text.includes('Approval required'));
    assert.ok(notice);
    const id = notice.text.match(/\/approve (\w+)/)[1];

    await adapter.handleMessage({ chat: { id: 111 }, text: `/approve ${id}` });
    await pending;
    assert.strictEqual(settled.approved, true);
    assert.strictEqual(settled.approver, 'telegram:111');
});

test('unrelated slash commands fall through to the legacy bot', async () => {
    const { adapter } = buildAdapter([]);
    const consumed = await adapter.handleMessage({ chat: { id: 42 }, text: '/status' });
    assert.strictEqual(consumed, false);
});

test('/agihealth reports runtime health', async () => {
    const { bot, adapter } = buildAdapter([]);
    await adapter.handleMessage({ chat: { id: 42 }, text: '/agihealth' });
    assert.ok(bot.sent[0].text.includes('Runtime health'));
    assert.ok(bot.sent[0].text.includes('Audit chain valid: true'));
});
