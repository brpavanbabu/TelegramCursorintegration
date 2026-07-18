/**
 * Minimal Telegram Bot API client — zero dependencies, uses Node's built-in
 * fetch. Long polling; no webhook/server needed, works behind NAT.
 */
'use strict';

class TelegramClient {
  constructor(token, { apiBase = 'https://api.telegram.org' } = {}) {
    if (!token) throw new Error('TelegramClient needs a bot token');
    this.base = `${apiBase}/bot${token}`;
    this.running = false;
  }

  async call(method, params = {}) {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(`Telegram ${method} failed: ${body.description || res.status}`);
    return body.result;
  }

  sendMessage(chatId, text, keyboard) {
    const params = { chat_id: chatId, text };
    if (keyboard) {
      params.reply_markup = {
        inline_keyboard: keyboard.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))),
      };
    }
    return this.call('sendMessage', params);
  }

  editMessageText(chatId, messageId, text) {
    return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text });
  }

  answerCallbackQuery(id, text) {
    return this.call('answerCallbackQuery', { callback_query_id: id, text }).catch(() => {});
  }

  /**
   * Long-poll for updates forever. onUpdate(update) is awaited per update;
   * errors are logged and polling continues.
   */
  async poll(onUpdate) {
    this.running = true;
    let offset = 0;
    while (this.running) {
      try {
        const updates = await this.call('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
        for (const update of updates) {
          offset = update.update_id + 1;
          try {
            await onUpdate(update);
          } catch (err) {
            console.error('update handler error:', err.message);
          }
        }
      } catch (err) {
        console.error('polling error (retrying in 3s):', err.message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  stop() {
    this.running = false;
  }
}

module.exports = { TelegramClient };
