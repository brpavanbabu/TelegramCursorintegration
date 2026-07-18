/**
 * Bot authentication — password gate with lockout, persisted authorized chats.
 * Mirrors the security model of the original telegram-cursor bot: 3 failed
 * attempts locks a chat out for 5 minutes; authorized chats survive restarts.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { stateDir, ensureDirs } = require('../engine/state');

const MAX_ATTEMPTS = 3;
const LOCKOUT_MS = 5 * 60 * 1000;

function hash(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

class AuthManager {
  constructor(workspaceDir, password, { now = Date.now } = {}) {
    if (!password) throw new Error('AuthManager needs a password');
    this.workspaceDir = workspaceDir;
    this.passwordHash = hash(password);
    this.now = now;
    this.attempts = new Map(); // chatId -> { count, lockedUntil }
    this.file = path.join(stateDir(workspaceDir), 'bot-auth.json');
    this.authorized = new Set(this._load());
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')).authorized || [];
    } catch {
      return [];
    }
  }

  _save() {
    ensureDirs(this.workspaceDir);
    fs.writeFileSync(this.file, JSON.stringify({ authorized: [...this.authorized] }, null, 2));
  }

  isAuthorized(chatId) {
    return this.authorized.has(String(chatId));
  }

  /** Returns { ok, locked, remainingAttempts, lockedForMs } */
  attempt(chatId, password) {
    const key = String(chatId);
    const st = this.attempts.get(key) || { count: 0, lockedUntil: 0 };

    if (st.lockedUntil > this.now()) {
      return { ok: false, locked: true, lockedForMs: st.lockedUntil - this.now() };
    }

    if (hash(password) === this.passwordHash) {
      this.attempts.delete(key);
      this.authorized.add(key);
      this._save();
      return { ok: true };
    }

    st.count += 1;
    if (st.count >= MAX_ATTEMPTS) {
      st.lockedUntil = this.now() + LOCKOUT_MS;
      st.count = 0;
      this.attempts.set(key, st);
      return { ok: false, locked: true, lockedForMs: LOCKOUT_MS };
    }
    this.attempts.set(key, st);
    return { ok: false, locked: false, remainingAttempts: MAX_ATTEMPTS - st.count };
  }

  logout(chatId) {
    this.authorized.delete(String(chatId));
    this._save();
  }
}

module.exports = { AuthManager };
