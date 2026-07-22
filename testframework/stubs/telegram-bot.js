'use strict';

/**
 * Sentinel Test Framework — Telegram Bot API stub
 *
 * Drop-in replacement for `node-telegram-bot-api` used through the sandbox
 * loader. Captures registered handlers and every outgoing API call, and lets
 * tests inject incoming messages exactly like the real long-polling client
 * would deliver them (onText handlers + 'message' listeners).
 */

const { fn } = require('../core/mock');

class FakeTelegramBot {
  constructor(token, options = {}) {
    this.token = token;
    this.options = options;
    this.textHandlers = [];
    this.listeners = new Map();
    this._messageIdSeq = 1;

    this.sendMessage = fn(async (chatId, text, opts) => ({
      message_id: this._messageIdSeq++,
      chat: { id: chatId },
      text,
    }));
    this.editMessageText = fn(async () => ({}));
    this.sendChatAction = fn(async () => true);
    this.stopPolling = fn(async () => undefined);
  }

  onText(regexp, callback) {
    this.textHandlers.push({ regexp, callback });
  }

  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(callback);
    return this;
  }

  async emit(event, ...args) {
    for (const listener of this.listeners.get(event) || []) {
      await listener(...args);
    }
  }

  /**
   * Simulate an incoming Telegram message. Mirrors the real library:
   * matching onText handlers fire, then all 'message' listeners fire.
   */
  async receive(msg) {
    const normalized = {
      message_id: this._messageIdSeq++,
      date: Math.floor(1700000000),
      chat: { id: 1, type: 'private' },
      from: { id: 1, is_bot: false, first_name: 'Tester' },
      ...msg,
    };
    if (typeof normalized.chat === 'number') normalized.chat = { id: normalized.chat, type: 'private' };

    for (const { regexp, callback } of this.textHandlers) {
      regexp.lastIndex = 0;
      const match = regexp.exec(normalized.text || '');
      if (match) await callback(normalized, match);
    }
    await this.emit('message', normalized);
    return normalized;
  }

  /* ----------------- test inspection helpers ----------------- */

  get sent() {
    return this.sendMessage.mock.calls.map(([chatId, text, opts]) => ({ chatId, text, opts }));
  }

  sentTo(chatId) {
    return this.sent.filter((m) => m.chatId === chatId);
  }

  lastMessage(chatId = null) {
    const pool = chatId === null ? this.sent : this.sentTo(chatId);
    return pool.length ? pool[pool.length - 1] : null;
  }

  sentTextIncludes(needle, chatId = null) {
    const pool = chatId === null ? this.sent : this.sentTo(chatId);
    return pool.some((m) => String(m.text).includes(needle));
  }

  clearOutbox() {
    this.sendMessage.mockClear();
  }
}

module.exports = { FakeTelegramBot };
