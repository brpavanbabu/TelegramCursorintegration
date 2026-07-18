#!/usr/bin/env node
/**
 * PlugStack Deploy Bot — deploy and manage full app stacks from Telegram.
 *
 *   TELEGRAM_BOT_TOKEN=... PLUGSTACK_BOT_PASSWORD=... node platform/bot/bot.js
 *
 * Or reuse the existing config.json from the telegram-cursor bot
 * (telegramBotToken + password fields).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const engine = require('../engine/api');
const { AuthManager } = require('./auth');
const { Router } = require('./commands');
const { TelegramClient } = require('./telegram');

const WORKSPACE = process.cwd();

function loadConfig() {
  let fileCfg = {};
  const cfgPath = path.join(WORKSPACE, 'config.json');
  if (fs.existsSync(cfgPath)) {
    try { fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* ignore */ }
  }
  const token = process.env.TELEGRAM_BOT_TOKEN || fileCfg.telegramBotToken;
  const password = process.env.PLUGSTACK_BOT_PASSWORD || fileCfg.password;
  if (!token) {
    console.error('✖ No bot token. Set TELEGRAM_BOT_TOKEN or add "telegramBotToken" to config.json');
    process.exit(1);
  }
  if (!password) {
    console.error('✖ No password. Set PLUGSTACK_BOT_PASSWORD or add "password" to config.json');
    process.exit(1);
  }
  return { token, password };
}

async function main() {
  const { token, password } = loadConfig();
  const auth = new AuthManager(WORKSPACE, password);
  const router = new Router({ workspaceDir: WORKSPACE, engine, auth });
  const client = new TelegramClient(token);

  const me = await client.call('getMe');
  console.log(`🔌 PlugStack Deploy Bot online as @${me.username}`);
  console.log(`   Workspace: ${WORKSPACE}`);
  console.log(`   Stacks:    ${engine.listStacks(WORKSPACE).map((s) => s.name).join(', ') || '(none)'}`);

  process.on('SIGINT', () => { console.log('\nShutting down.'); client.stop(); process.exit(0); });

  await client.poll(async (update) => {
    if (update.message && update.message.text) {
      const reply = await router.handleMessage(update.message);
      await client.sendMessage(update.message.chat.id, reply.text, reply.keyboard);
    } else if (update.callback_query) {
      const query = update.callback_query;
      await client.answerCallbackQuery(query.id, 'Working...');
      const reply = await router.handleCallback(query);
      if (reply.edit && query.message) {
        await client.editMessageText(query.message.chat.id, query.message.message_id, reply.text)
          .catch(() => client.sendMessage(query.message.chat.id, reply.text));
      } else {
        await client.sendMessage(query.message.chat.id, reply.text, reply.keyboard);
      }
    }
  });
}

main().catch((err) => {
  console.error('✖ Fatal:', err.message);
  process.exit(1);
});
