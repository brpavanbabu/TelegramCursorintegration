/**
 * Audit trail — append-only JSONL of every deploy/stop/auth action.
 * This is the paper trail teams pay for: who did what, to which stack, when.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { stateDir, ensureDirs } = require('../engine/state');

function auditFile(workspaceDir) {
  return path.join(stateDir(workspaceDir), 'audit.jsonl');
}

function record(workspaceDir, event) {
  ensureDirs(workspaceDir);
  const entry = { ts: new Date().toISOString(), ...event };
  fs.appendFileSync(auditFile(workspaceDir), JSON.stringify(entry) + '\n');
  return entry;
}

function tail(workspaceDir, n = 10) {
  const file = auditFile(workspaceDir);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .slice(-n)
    .map((line) => JSON.parse(line));
}

module.exports = { record, tail, auditFile };
