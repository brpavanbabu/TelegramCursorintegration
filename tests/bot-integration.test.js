'use strict';

/**
 * End-to-end tests for telegram-cursor-bot.js.
 *
 * The whole bot runs inside the Sentinel sandbox:
 *   - node-telegram-bot-api  -> FakeTelegramBot (captures every reply)
 *   - robotjs                -> stub (native module never loaded)
 *   - child_process.exec     -> controllable stub (no PowerShell needed)
 *   - fs                     -> virtual config.json + virtual workspace
 *   - timers/Date            -> FakeClock (30s monitoring loops run instantly)
 *
 * This exercises the REAL production code paths: auth gate, command
 * execution, progress updates, file-change detection, concurrency guard,
 * error handling and every slash command — on any OS, with no network.
 */

const path = require('path');
const fsReal = require('fs');
const { describe, it, expect, beforeEach, mock, loadSandboxed, ExitError } = require('../testframework');
const { FakeTelegramBot } = require('../testframework/stubs/telegram-bot');

const BOT_PATH = path.join(__dirname, '..', 'telegram-cursor-bot.js');
const CHAT = 4242;
const VALID_CONFIG = {
  telegramBotToken: '000000000:TEST_FAKE_TOKEN_FOR_SANDBOX_ONLY',
  workspacePath: '/virtual/workspace',
  password: 'TestPass123',
};

function startBot({ config = VALID_CONFIG, files = ['existing.txt'] } = {}) {
  const clock = new mock.FakeClock({ now: 1700000000000 });
  const workspace = { files: [...files] };
  const writeHistory = [];
  const execCalls = [];
  let execBehavior = (cmd, cb) => cb(null, 'ok', '');

  let botInstance = null;
  class CapturingBot extends FakeTelegramBot {
    constructor(...args) {
      super(...args);
      botInstance = this;
    }
  }

  const fsOverrides = {
    existsSync: (p) => {
      if (String(p).endsWith('config.json')) return config !== null;
      return fsReal.existsSync(p);
    },
    readFileSync: (p, enc) => {
      if (String(p).endsWith('config.json')) return JSON.stringify(config);
      return fsReal.readFileSync(p, enc);
    },
    writeFileSync: (p, content) => {
      writeHistory.push({ file: path.basename(String(p)), content });
    },
    unlinkSync: () => {},
    readdirSync: () =>
      workspace.files.map((name) => ({
        name,
        isFile: () => true,
        isDirectory: () => false,
      })),
  };

  const sandbox = loadSandboxed(BOT_PATH, {
    stubs: {
      'node-telegram-bot-api': CapturingBot,
      robotjs: {},
      child_process: { exec: (cmd, cb) => { execCalls.push(cmd); execBehavior(cmd, cb); } },
    },
    fs: fsOverrides,
    timers: clock.fns,
    Date: clock.fns.Date,
    sandboxRelative: true, // fresh password-security instance per bot load
  });

  return {
    bot: botInstance,
    clock,
    workspace,
    writeHistory,
    execCalls,
    console: sandbox.console,
    setExecBehavior: (fn) => { execBehavior = fn; },
  };
}

async function authenticate(ctx, chatId = CHAT) {
  await ctx.bot.receive({ chat: { id: chatId }, text: VALID_CONFIG.password });
  ctx.bot.clearOutbox();
}

describe('bot startup & configuration', { reqs: ['FUN-001'] }, () => {
  it('exits with code 1 when config.json is missing', () => {
    let caught = null;
    try {
      startBot({ config: null });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExitError);
    expect(caught.code).toBe(1);
  });

  it('exits with code 1 when config is missing token or workspace', () => {
    let caught = null;
    try {
      startBot({ config: { telegramBotToken: '', workspacePath: '' } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExitError);
    expect(caught.code).toBe(1);
  });

  it('starts cleanly with a valid config and registers all handlers', () => {
    const ctx = startBot();
    expect(ctx.bot).not.toBeNull();
    expect(ctx.bot.token).toBe(VALID_CONFIG.telegramBotToken);
    expect(ctx.console.includes('Bot started successfully')).toBe(true);
    // /start /status /clear /logout /help
    expect(ctx.bot.textHandlers).toHaveLength(5);
    expect(ctx.bot.listeners.has('message')).toBe(true);
    expect(ctx.bot.listeners.has('polling_error')).toBe(true);
  });
});

describe('authentication gate', { reqs: ['SEC-001'] }, () => {
  it('a non-authenticated message is treated as a password attempt, not a command', async () => {
    const ctx = startBot();
    await ctx.bot.receive({ chat: { id: CHAT }, text: 'build me an app' });
    expect(ctx.bot.sentTextIncludes('Incorrect Password')).toBe(true);
    expect(ctx.execCalls).toHaveLength(0); // nothing was executed
  });

  it('the configured password authenticates and unlocks command execution', async () => {
    const ctx = startBot();
    await ctx.bot.receive({ chat: { id: CHAT }, text: VALID_CONFIG.password });
    expect(ctx.bot.sentTextIncludes('Authentication Successful')).toBe(true);

    await ctx.bot.receive({ chat: { id: CHAT }, text: 'build me an app' });
    expect(ctx.bot.sentTextIncludes('Command Received')).toBe(true);
    expect(ctx.execCalls.length).toBeGreaterThan(0);
  });

  it('/logout revokes access and the next command asks for the password again', async () => {
    const ctx = startBot();
    await authenticate(ctx);
    await ctx.bot.receive({ chat: { id: CHAT }, text: '/logout' });
    expect(ctx.bot.sentTextIncludes('Logged Out')).toBe(true);

    ctx.bot.clearOutbox();
    await ctx.bot.receive({ chat: { id: CHAT }, text: 'do something' });
    expect(ctx.bot.sentTextIncludes('Incorrect Password')).toBe(true);
    expect(ctx.execCalls).toHaveLength(0);
  }, { reqs: ['SEC-004'] });
});

describe('command execution pipeline', () => {
  it('executes a command via PowerShell automation and reports progress', async () => {
    const ctx = startBot();
    await authenticate(ctx);

    await ctx.bot.receive({ chat: { id: CHAT }, text: 'build me a todo app' });

    expect(ctx.bot.sentTextIncludes('Command Received')).toBe(true);
    expect(ctx.bot.sentTextIncludes('Progress: 50%')).toBe(true);
    expect(ctx.bot.sentTextIncludes('Progress: 75%')).toBe(true);
    expect(ctx.execCalls).toHaveLength(1);
    expect(ctx.execCalls[0]).toMatch(/powershell/);
    // the automation script was written and contains the command
    const script = ctx.writeHistory.find((w) => w.file === 'execute-cursor-temp.ps1');
    expect(script).toBeDefined();
    expect(script.content).toContain('build me a todo app');
  });

  it('detects new workspace files and announces completion', async () => {
    const ctx = startBot();
    await authenticate(ctx);
    await ctx.bot.receive({ chat: { id: CHAT }, text: 'create the app' });

    // Cursor "creates" a file; the 2s monitor interval picks it up.
    ctx.workspace.files.push('todo-app.js');
    await ctx.clock.tickAsync(2000);

    expect(ctx.bot.sentTextIncludes('Work Finished 100%')).toBe(true);
    expect(ctx.bot.sentTextIncludes('todo-app.js')).toBe(true);
    expect(ctx.clock.pendingTimerCount).toBe(0); // monitor interval cleared
  });

  it('reports a generic completion after the 30s monitoring window if nothing changed', async () => {
    const ctx = startBot();
    await authenticate(ctx);
    await ctx.bot.receive({ chat: { id: CHAT }, text: 'noop command' });

    await ctx.clock.tickAsync(32000);
    expect(ctx.bot.sentTextIncludes('Check Cursor IDE for results')).toBe(true);
  });

  it('reports execution errors to the user instead of crashing', async () => {
    const ctx = startBot();
    ctx.setExecBehavior((cmd, cb) => cb(new Error('powershell exploded'), '', 'stderr says no'));
    await authenticate(ctx);

    await ctx.bot.receive({ chat: { id: CHAT }, text: 'this will fail' });
    expect(ctx.bot.sentTextIncludes('Execution Error')).toBe(true);
  });

  it('rejects a second command while one is still running', { reqs: ['FUN-003'] }, async () => {
    const ctx = startBot();
    const pending = [];
    ctx.setExecBehavior((cmd, cb) => pending.push(cb)); // hold execution open
    await authenticate(ctx);

    const first = ctx.bot.receive({ chat: { id: CHAT }, text: 'long running build' });
    await ctx.bot.receive({ chat: { id: CHAT }, text: 'second command' });
    expect(ctx.bot.sentTextIncludes('Another command is running')).toBe(true);

    pending.shift()(null, 'ok', ''); // release the first command
    await first;
    expect(ctx.execCalls).toHaveLength(1);
  });

  it('includes previous conversation context in follow-up commands', { reqs: ['FUN-002', 'FUN-006'] }, async () => {
    const ctx = startBot();
    await authenticate(ctx);

    await ctx.bot.receive({ chat: { id: CHAT }, text: 'build a calculator' });
    await ctx.bot.receive({ chat: { id: CHAT }, text: 'now add dark mode' });

    const scripts = ctx.writeHistory.filter((w) => w.file === 'execute-cursor-temp.ps1');
    expect(scripts).toHaveLength(2);
    expect(scripts[0].content).not.toContain('Context from previous messages');
    expect(scripts[1].content).toContain('Context from previous messages');
    expect(scripts[1].content).toContain('build a calculator');
  });
});

describe('slash commands', () => {
  it('/start sends the welcome message without requiring auth', async () => {
    const ctx = startBot();
    await ctx.bot.receive({ chat: { id: CHAT }, text: '/start' });
    expect(ctx.bot.sentTextIncludes('Telegram + Cursor Integration Bot')).toBe(true);
    expect(ctx.execCalls).toHaveLength(0);
  });

  it('/help lists available commands', async () => {
    const ctx = startBot();
    await ctx.bot.receive({ chat: { id: CHAT }, text: '/help' });
    expect(ctx.bot.sentTextIncludes('Help & Usage')).toBe(true);
    expect(ctx.bot.sentTextIncludes('/logout')).toBe(true);
  });

  it('/status reports idle state, workspace and session size', { reqs: ['FUN-005'] }, async () => {
    const ctx = startBot();
    await authenticate(ctx);
    await ctx.bot.receive({ chat: { id: CHAT }, text: '/status' });
    const status = ctx.bot.lastMessage(CHAT);
    expect(status.text).toContain('Bot Status');
    expect(status.text).toContain('Idle');
    expect(status.text).toContain(VALID_CONFIG.workspacePath);
  });

  it('/status counts session messages after a command', { reqs: ['FUN-002'] }, async () => {
    const ctx = startBot();
    await authenticate(ctx);
    await ctx.bot.receive({ chat: { id: CHAT }, text: 'first command' });
    await ctx.bot.receive({ chat: { id: CHAT }, text: '/status' });
    // one user message + one simulated assistant reply
    expect(ctx.bot.lastMessage(CHAT).text).toContain('Session Messages:* 2');
  });

  it('/clear resets the conversation context', { reqs: ['FUN-004'] }, async () => {
    const ctx = startBot();
    await authenticate(ctx);
    await ctx.bot.receive({ chat: { id: CHAT }, text: 'remember this' });
    await ctx.bot.receive({ chat: { id: CHAT }, text: '/clear' });
    expect(ctx.bot.sentTextIncludes('Context Cleared')).toBe(true);

    await ctx.bot.receive({ chat: { id: CHAT }, text: '/status' });
    expect(ctx.bot.lastMessage(CHAT).text).toContain('Session Messages:* 0');
  });
});
