/**
 * Runtime state — tracks what is running under .plugstack/ in the workspace.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function stateDir(workspaceDir) {
  return path.join(workspaceDir, '.plugstack');
}

function logsDir(workspaceDir) {
  return path.join(stateDir(workspaceDir), 'logs');
}

function statePath(workspaceDir) {
  return path.join(stateDir(workspaceDir), 'state.json');
}

function ensureDirs(workspaceDir) {
  fs.mkdirSync(logsDir(workspaceDir), { recursive: true });
}

function readState(workspaceDir) {
  try {
    return JSON.parse(fs.readFileSync(statePath(workspaceDir), 'utf8'));
  } catch {
    return { stacks: {} };
  }
}

function writeState(workspaceDir, state) {
  ensureDirs(workspaceDir);
  fs.writeFileSync(statePath(workspaceDir), JSON.stringify(state, null, 2));
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

module.exports = { stateDir, logsDir, ensureDirs, readState, writeState, isPidAlive };
