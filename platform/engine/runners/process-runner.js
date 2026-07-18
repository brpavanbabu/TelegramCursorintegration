/**
 * Process runner — runs a plugin as a local OS process (no Docker needed).
 * Logs go to .plugstack/logs/<stack>-<service>.log, pids are tracked in state.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { logsDir, ensureDirs, readState, writeState, isPidAlive } = require('../state');

function logFile(workspaceDir, stackName, serviceName) {
  return path.join(logsDir(workspaceDir), `${stackName}-${serviceName}.log`);
}

function up(workspaceDir, stackName, entry) {
  ensureDirs(workspaceDir);
  const state = readState(workspaceDir);
  state.stacks[stackName] = state.stacks[stackName] || { services: {} };
  const existing = state.stacks[stackName].services[entry.name];
  if (existing && existing.pid && isPidAlive(existing.pid)) {
    return { pid: existing.pid, alreadyRunning: true };
  }

  const cwd = entry.config.cwd
    ? path.resolve(entry.config.stackDir, entry.config.cwd)
    : entry.plugin.dir;
  if (!fs.existsSync(cwd)) {
    throw new Error(`Service "${entry.name}": working directory does not exist: ${cwd}`);
  }

  const out = fs.openSync(logFile(workspaceDir, stackName, entry.name), 'a');
  fs.writeSync(out, `\n===== ${new Date().toISOString()} starting "${entry.name}" (${entry.command}) =====\n`);

  const child = spawn(entry.command, {
    cwd,
    shell: true,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ...stringifyValues(entry.env) },
  });
  child.unref();
  fs.closeSync(out);

  state.stacks[stackName].services[entry.name] = {
    runner: 'process',
    pid: child.pid,
    command: entry.command,
    cwd,
    startedAt: new Date().toISOString(),
    health: entry.health || null,
    config: publicConfig(entry.config),
  };
  writeState(workspaceDir, state);
  return { pid: child.pid, alreadyRunning: false };
}

function down(workspaceDir, stackName, serviceName) {
  const state = readState(workspaceDir);
  const svc = state.stacks[stackName] && state.stacks[stackName].services[serviceName];
  if (!svc || !svc.pid) return { stopped: false };

  let stopped = false;
  if (isPidAlive(svc.pid)) {
    try {
      // Negative pid kills the whole process group (shell + its children)
      process.kill(-svc.pid, 'SIGTERM');
    } catch {
      try { process.kill(svc.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    stopped = true;
  }
  delete state.stacks[stackName].services[serviceName];
  if (!Object.keys(state.stacks[stackName].services).length) delete state.stacks[stackName];
  writeState(workspaceDir, state);
  return { stopped };
}

function status(workspaceDir, stackName, serviceName) {
  const state = readState(workspaceDir);
  const svc = state.stacks[stackName] && state.stacks[stackName].services[serviceName];
  if (!svc) return { running: false };
  return { running: isPidAlive(svc.pid), pid: svc.pid, startedAt: svc.startedAt, config: svc.config, health: svc.health };
}

function stringifyValues(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k] = String(v);
  return out;
}

function publicConfig(config) {
  const { stackDir, pluginDir, ...rest } = config;
  return rest;
}

module.exports = { up, down, status, logFile };
