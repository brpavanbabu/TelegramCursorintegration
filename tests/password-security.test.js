'use strict';

/**
 * Unit tests for password-security.js — the authentication layer that
 * protects the bot from attackers. Every test gets a FRESH sandboxed module
 * instance and a virtual clock, so lockout timing is tested in milliseconds
 * instead of real minutes.
 */

const path = require('path');
const { describe, it, expect, beforeEach, mock, loadSandboxed } = require('../testframework');
const { FakeTelegramBot } = require('../testframework/stubs/telegram-bot');

const MODULE = path.join(__dirname, '..', 'password-security.js');
const PASSWORD = 'CorrectHorse42';
const CHAT = 1001;

let security;
let clock;
let bot;

beforeEach(() => {
  clock = new mock.FakeClock({ now: 1700000000000 });
  security = loadSandboxed(MODULE, { Date: clock.fns.Date }).exports;
  bot = new FakeTelegramBot('fake-token');
});

describe('password-security: authentication basics', { reqs: ['SEC-001'] }, () => {
  it('exports the full security API', () => {
    for (const name of ['isAuthenticated', 'requestPassword', 'verifyPassword', 'logout', 'isLockedOut', 'getLockoutTimeRemaining']) {
      expect(typeof security[name]).toBe('function');
    }
    expect(security.MAX_ATTEMPTS).toBe(3);
    expect(security.LOCKOUT_DURATION).toBe(5 * 60 * 1000);
  });

  it('unknown chats are not authenticated', () => {
    expect(security.isAuthenticated(CHAT, PASSWORD)).toBeFalsy();
  });

  it('correct password authenticates the chat', async () => {
    const ok = await security.verifyPassword(bot, CHAT, PASSWORD, PASSWORD);
    expect(ok).toBe(true);
    expect(security.isAuthenticated(CHAT, PASSWORD)).toBe(true);
    expect(bot.sentTextIncludes('Password Verified')).toBe(true);
  });

  it('wrong password is rejected and warns about remaining attempts', async () => {
    const ok = await security.verifyPassword(bot, CHAT, 'wrong-password', PASSWORD);
    expect(ok).toBe(false);
    expect(security.isAuthenticated(CHAT, PASSWORD)).toBeFalsy();
    expect(bot.sentTextIncludes('Incorrect Password')).toBe(true);
    expect(bot.sentTextIncludes('2 attempt(s) remaining')).toBe(true);
  });

  it('requestPassword prompts for the password', async () => {
    const sent = await security.requestPassword(bot, CHAT);
    expect(sent).toBe(true);
    expect(bot.sentTextIncludes('Password Required')).toBe(true);
  });

  it('a successful login resets the failed-attempt counter', async () => {
    await security.verifyPassword(bot, CHAT, 'bad-1', PASSWORD);
    await security.verifyPassword(bot, CHAT, 'bad-2', PASSWORD);
    expect(await security.verifyPassword(bot, CHAT, PASSWORD, PASSWORD)).toBe(true);
    // counter reset: two fresh failures must NOT lock out
    security.logout(CHAT);
    await security.verifyPassword(bot, CHAT, 'bad-3', PASSWORD);
    await security.verifyPassword(bot, CHAT, 'bad-4', PASSWORD);
    expect(security.isLockedOut(CHAT)).toBeFalsy();
  });
});

describe('password-security: brute-force lockout', { reqs: ['SEC-002'] }, () => {
  async function failThreeTimes() {
    for (let i = 0; i < 3; i++) {
      await security.verifyPassword(bot, CHAT, `wrong-${i}`, PASSWORD);
    }
  }

  it('locks the chat after 3 failed attempts', async () => {
    await failThreeTimes();
    expect(security.isLockedOut(CHAT)).toBeTruthy();
    expect(bot.sentTextIncludes('locked out for 5 minutes')).toBe(true);
  });

  it('even the CORRECT password is rejected while locked out', async () => {
    await failThreeTimes();
    const ok = await security.verifyPassword(bot, CHAT, PASSWORD, PASSWORD);
    expect(ok).toBe(false);
    expect(security.isAuthenticated(CHAT, PASSWORD)).toBeFalsy();
    expect(bot.sentTextIncludes('Account Locked')).toBe(true);
  });

  it('requestPassword reports the lockout instead of prompting', async () => {
    await failThreeTimes();
    bot.clearOutbox();
    const sent = await security.requestPassword(bot, CHAT);
    expect(sent).toBe(false);
    expect(bot.sentTextIncludes('Account Locked')).toBe(true);
    expect(bot.sentTextIncludes('Password Required')).toBe(false);
  });

  it('reports remaining lockout minutes', async () => {
    await failThreeTimes();
    expect(security.getLockoutTimeRemaining(CHAT)).toBe(5);
    clock.tick(2 * 60 * 1000 + 1000);
    expect(security.getLockoutTimeRemaining(CHAT)).toBe(3);
  });

  it('lockout is per-chat: other chats are unaffected', async () => {
    await failThreeTimes();
    expect(security.isLockedOut(CHAT)).toBeTruthy();
    expect(security.isLockedOut(2002)).toBeFalsy();
    expect(await security.verifyPassword(bot, 2002, PASSWORD, PASSWORD)).toBe(true);
  });
});

describe('password-security: lockout expiry (virtual time)', { reqs: ['SEC-003'] }, () => {
  it('the lockout expires after exactly 5 minutes', async () => {
    for (let i = 0; i < 3; i++) await security.verifyPassword(bot, CHAT, 'nope', PASSWORD);
    expect(security.isLockedOut(CHAT)).toBeTruthy();

    clock.tick(security.LOCKOUT_DURATION - 1000);
    expect(security.isLockedOut(CHAT)).toBeTruthy();

    clock.tick(2000); // now 1s past the lockout window
    expect(security.isLockedOut(CHAT)).toBeFalsy();
    expect(security.getLockoutTimeRemaining(CHAT)).toBe(0);
    expect(await security.verifyPassword(bot, CHAT, PASSWORD, PASSWORD)).toBe(true);
  });
});

describe('password-security: logout', { reqs: ['SEC-004'] }, () => {
  it('logout revokes authentication until the password is re-entered', async () => {
    await security.verifyPassword(bot, CHAT, PASSWORD, PASSWORD);
    expect(security.isAuthenticated(CHAT, PASSWORD)).toBe(true);
    security.logout(CHAT);
    expect(security.isAuthenticated(CHAT, PASSWORD)).toBeFalsy();
    expect(await security.verifyPassword(bot, CHAT, PASSWORD, PASSWORD)).toBe(true);
    expect(security.isAuthenticated(CHAT, PASSWORD)).toBe(true);
  });

  it('logout of an unknown chat is a safe no-op', () => {
    expect(() => security.logout(999999)).not.toThrow();
  });
});
