/**
 * Command router — pure logic, no network. Takes incoming messages/button
 * presses and returns reply objects, so the whole product flow is testable
 * without a Telegram token.
 *
 * Reply shape: { text, keyboard?: [[{text, data}]] , edit?: true }
 */
'use strict';

const audit = require('./audit');

const HELP = `🔌 PlugStack Deploy Bot

/stacks — list deployable stacks
/deploy <stack> — deploy a stack (asks for confirmation)
/stop <stack> — stop a stack (asks for confirmation)
/status <stack> — live service status
/logs <stack> <service> — last 30 log lines
/audit — recent deploy history
/logout — require password again
/help — this message`;

function fmtServices(services) {
  return services
    .map((s) => {
      const icon = s.ok === false || s.running === false ? '❌' : s.ok || s.running ? '✅' : '❔';
      const health = s.healthy === true ? ' (healthy)' : s.healthy === false ? ' (UNHEALTHY)' : '';
      const detail = s.detail ? ` — ${s.detail}` : s.running === null ? ' — unknown (no docker daemon)' : '';
      const url = s.url ? `\n      ${s.url}` : '';
      return `  ${icon} ${s.name}${health}${detail}${url}`;
    })
    .join('\n');
}

function who(msg) {
  const from = msg.from || {};
  const name = from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(' ');
  return name || String((msg.chat && msg.chat.id) || from.id || 'unknown');
}

class Router {
  constructor({ workspaceDir, engine, auth }) {
    this.workspaceDir = workspaceDir;
    this.engine = engine;
    this.auth = auth;
  }

  /** Handle a plain text message. Returns a reply object (or a Promise of one). */
  async handleMessage(msg) {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    // -------- authentication gate
    if (!this.auth.isAuthorized(chatId)) {
      if (text === '/start' || text === '/help') {
        return { text: '🔒 Password required. Send the deploy password to continue.' };
      }
      const res = this.auth.attempt(chatId, text);
      if (res.ok) {
        audit.record(this.workspaceDir, { action: 'auth.success', chatId, user: who(msg) });
        return { text: `✅ Password verified. You can deploy now.\n\n${HELP}` };
      }
      audit.record(this.workspaceDir, { action: 'auth.fail', chatId, user: who(msg) });
      if (res.locked) {
        return { text: `🔒 Locked out for ${Math.ceil(res.lockedForMs / 60000)} minute(s) after repeated failures.` };
      }
      return { text: `❌ Incorrect password (${res.remainingAttempts} attempt(s) remaining).` };
    }

    // -------- commands
    const [cmd, ...args] = text.split(/\s+/);
    try {
      switch (cmd) {
        case '/start':
        case '/help':
          return { text: HELP };

        case '/stacks': {
          const stacks = this.engine.listStacks(this.workspaceDir);
          if (!stacks.length) return { text: 'No stacks found in ./stacks/' };
          const lines = stacks.map((s) => `🧩 ${s.name} (${s.services.length} services)${s.description ? `\n    ${s.description}` : ''}`);
          return { text: `Deployable stacks:\n\n${lines.join('\n')}\n\nDeploy one: /deploy <name>` };
        }

        case '/deploy': {
          if (!args[0]) return { text: 'Usage: /deploy <stack>  (see /stacks)' };
          this.engine.findStackFile(this.workspaceDir, args[0]); // validate before asking
          return {
            text: `Deploy stack "${args[0]}"?`,
            keyboard: [[{ text: '🚀 Deploy', data: `deploy:${args[0]}` }, { text: '✖ Cancel', data: 'cancel' }]],
          };
        }

        case '/stop': {
          if (!args[0]) return { text: 'Usage: /stop <stack>' };
          this.engine.findStackFile(this.workspaceDir, args[0]);
          return {
            text: `Stop stack "${args[0]}"?`,
            keyboard: [[{ text: '🛑 Stop', data: `stop:${args[0]}` }, { text: '✖ Cancel', data: 'cancel' }]],
          };
        }

        case '/status': {
          if (!args[0]) return { text: 'Usage: /status <stack>' };
          const st = await this.engine.statusStack(this.workspaceDir, args[0]);
          return { text: `Stack "${st.stack}":\n\n${fmtServices(st.services)}` };
        }

        case '/logs': {
          if (!args[0] || !args[1]) return { text: 'Usage: /logs <stack> <service>' };
          const logs = this.engine.tailLogs(this.workspaceDir, args[0], args[1], 30);
          const clipped = logs.length > 3500 ? logs.slice(-3500) : logs;
          return { text: `Logs for ${args[1]} (${args[0]}):\n\n${clipped}` };
        }

        case '/audit': {
          const events = audit.tail(this.workspaceDir, 10);
          if (!events.length) return { text: 'No audit events yet.' };
          const lines = events.map((e) => `${e.ts}  ${e.user || e.chatId}  ${e.action}${e.stack ? ` ${e.stack}` : ''}${e.ok === false ? ' (FAILED)' : ''}`);
          return { text: `Recent activity:\n\n${lines.join('\n')}` };
        }

        case '/logout':
          this.auth.logout(chatId);
          audit.record(this.workspaceDir, { action: 'auth.logout', chatId, user: who(msg) });
          return { text: '👋 Logged out. Send the password to authenticate again.' };

        default:
          return { text: `Unknown command: ${cmd}\n\n${HELP}` };
      }
    } catch (err) {
      return { text: `⚠ ${err.message}` };
    }
  }

  /** Handle an inline-keyboard button press. Returns a reply object. */
  async handleCallback(query) {
    const chatId = query.message.chat.id;
    if (!this.auth.isAuthorized(chatId)) return { text: '🔒 Not authorized.', edit: true };

    const data = query.data || '';
    const [action, stackRef] = data.split(':');

    if (action === 'cancel') return { text: 'Cancelled.', edit: true };

    try {
      if (action === 'deploy') {
        const result = await this.engine.upStack(this.workspaceDir, stackRef, {});
        const allOk = result.services.every((s) => s.ok);
        audit.record(this.workspaceDir, { action: 'deploy', stack: result.stack, chatId, user: who(query), ok: allOk });
        return {
          text: `${allOk ? '✅' : '⚠'} Stack "${result.stack}" deployed:\n\n${fmtServices(result.services)}`,
          edit: true,
        };
      }
      if (action === 'stop') {
        const result = await this.engine.downStack(this.workspaceDir, stackRef);
        audit.record(this.workspaceDir, { action: 'stop', stack: result.stack, chatId, user: who(query), ok: true });
        const lines = result.services.map((s) => `  ${s.stopped ? '🛑' : '▫'} ${s.name} ${s.stopped ? 'stopped' : 'was not running'}`);
        return { text: `Stack "${result.stack}" stopped:\n\n${lines.join('\n')}`, edit: true };
      }
      return { text: `Unknown action: ${action}`, edit: true };
    } catch (err) {
      audit.record(this.workspaceDir, { action, stack: stackRef, chatId, ok: false, error: err.message });
      return { text: `⚠ ${action} failed: ${err.message}`, edit: true };
    }
  }
}

module.exports = { Router, HELP };
