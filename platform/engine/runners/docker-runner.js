/**
 * Docker runner — turns all docker-based services of a stack into a single
 * generated docker-compose file and drives `docker compose` with it.
 *
 * Works in two modes:
 *   - generate: always available, writes .plugstack/<stack>.compose.yml
 *   - up/down:  requires a running Docker daemon
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { stateDir, ensureDirs } = require('../state');
const { toYaml } = require('../yaml');

function composePath(workspaceDir, stackName) {
  return path.join(stateDir(workspaceDir), `${stackName}.compose.yml`);
}

/** Build a compose document from the docker entries of a launch plan. */
function buildCompose(stackName, entries) {
  const services = {};
  const volumes = {};

  for (const entry of entries) {
    const d = entry.docker;
    const svc = {
      image: d.image,
      container_name: `${stackName}-${entry.name}`,
      restart: 'unless-stopped',
    };
    if (d.command) svc.command = d.command;
    if (d.environment && Object.keys(d.environment).length) svc.environment = d.environment;
    if (d.ports && d.ports.length) svc.ports = d.ports.map(String);
    if (d.volumes && d.volumes.length) {
      svc.volumes = d.volumes.map(String);
      for (const v of d.volumes) {
        const name = String(v).split(':')[0];
        if (!name.startsWith('.') && !name.startsWith('/')) volumes[name] = {};
      }
    }
    // Only depend on other docker services within the same compose file
    const dockerDeps = (entry.dependsOn || []).filter((dep) => entries.some((e) => e.name === dep));
    if (dockerDeps.length) svc.depends_on = dockerDeps;
    services[entry.name] = svc;
  }

  const doc = { name: stackName, services };
  if (Object.keys(volumes).length) doc.volumes = volumes;
  return doc;
}

function generate(workspaceDir, stackName, entries) {
  ensureDirs(workspaceDir);
  const file = composePath(workspaceDir, stackName);
  fs.writeFileSync(file, toYaml(buildCompose(stackName, entries)));
  return file;
}

function daemonAvailable() {
  const res = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' });
  return res.status === 0;
}

function compose(workspaceDir, stackName, args) {
  const file = composePath(workspaceDir, stackName);
  return execFileSync('docker', ['compose', '-p', stackName, '-f', file, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function up(workspaceDir, stackName, entries) {
  const file = generate(workspaceDir, stackName, entries);
  if (!daemonAvailable()) {
    const err = new Error(
      `Docker daemon is not running. Compose file was generated at ${file} — ` +
      `start Docker and run: docker compose -p ${stackName} -f ${file} up -d`
    );
    err.composeFile = file;
    err.daemonMissing = true;
    throw err;
  }
  compose(workspaceDir, stackName, ['up', '-d', '--wait']);
  return { composeFile: file };
}

function down(workspaceDir, stackName) {
  const file = composePath(workspaceDir, stackName);
  if (!fs.existsSync(file) || !daemonAvailable()) return { stopped: false };
  compose(workspaceDir, stackName, ['down']);
  return { stopped: true };
}

function status(workspaceDir, stackName) {
  if (!daemonAvailable()) return null;
  try {
    const out = compose(workspaceDir, stackName, ['ps', '--format', 'json']);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

module.exports = { generate, up, down, status, composePath, daemonAvailable, buildCompose };
