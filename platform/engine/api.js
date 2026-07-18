/**
 * Programmatic engine API — the same operations the CLI performs, but as
 * functions returning structured results. Used by the Telegram deploy bot
 * (and anything else that wants to embed PlugStack).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { loadRegistry } = require('./registry');
const { resolveStack } = require('./resolver');
const { waitHealthy, checkOnce } = require('./health');
const processRunner = require('./runners/process-runner');
const dockerRunner = require('./runners/docker-runner');

function findStackFile(workspaceDir, ref) {
  const tries = [ref, `${ref}.json`, path.join('stacks', ref), path.join('stacks', `${ref}.json`)];
  for (const t of tries) {
    const full = path.resolve(workspaceDir, t);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  throw new Error(`Stack not found: "${ref}". Use listStacks() / the /stacks command to see what exists.`);
}

function listStacks(workspaceDir) {
  const dir = path.join(workspaceDir, 'stacks');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return {
          name: raw.name || f.replace(/\.json$/, ''),
          file: path.join('stacks', f),
          description: raw.description || '',
          services: Object.keys(raw.services || {}),
        };
      } catch {
        return { name: f.replace(/\.json$/, ''), file: path.join('stacks', f), description: '(unparseable)', services: [] };
      }
    });
}

function resolve(workspaceDir, ref) {
  const stackPath = findStackFile(workspaceDir, ref);
  const registry = loadRegistry(workspaceDir);
  return resolveStack(stackPath, registry);
}

function serviceUrl(entry) {
  const port = entry.config.port;
  if (!port) return null;
  return entry.health && entry.health.type === 'http' ? `http://localhost:${port}` : `localhost:${port}`;
}

/**
 * Bring a stack up. Returns { stack, services: [{name, runner, ok, detail, url}] }.
 * onProgress(text) is called with human-readable step updates.
 */
async function upStack(workspaceDir, ref, { onProgress = () => {} } = {}) {
  const { stack, plan } = resolve(workspaceDir, ref);
  const services = [];

  const dockerEntries = plan.filter((e) => e.runner === 'docker');
  if (dockerEntries.length) {
    onProgress(`Starting ${dockerEntries.length} docker service(s): ${dockerEntries.map((e) => e.name).join(', ')}...`);
    try {
      dockerRunner.up(workspaceDir, stack.name, dockerEntries);
      for (const e of dockerEntries) {
        services.push({ name: e.name, runner: 'docker', ok: true, detail: 'container up', url: serviceUrl(e) });
      }
    } catch (err) {
      if (err.daemonMissing) {
        for (const e of dockerEntries) {
          services.push({ name: e.name, runner: 'docker', ok: false, detail: 'skipped — no docker daemon (compose file generated)', url: serviceUrl(e) });
        }
      } else {
        throw err;
      }
    }
  }

  for (const entry of plan.filter((e) => e.runner === 'process')) {
    onProgress(`Starting ${entry.name}...`);
    const { pid, alreadyRunning } = processRunner.up(workspaceDir, stack.name, entry);
    if (alreadyRunning) {
      services.push({ name: entry.name, runner: 'process', ok: true, detail: `already running (pid ${pid})`, url: serviceUrl(entry) });
      continue;
    }
    const healthy = await waitHealthy(entry.health, { timeoutMs: Number(entry.config.healthTimeoutMs || 30000) });
    services.push({
      name: entry.name,
      runner: 'process',
      ok: healthy,
      detail: healthy ? `pid ${pid}, healthy` : `pid ${pid}, FAILED health check`,
      url: serviceUrl(entry),
    });
  }

  return { stack: stack.name, services };
}

/** Stop a stack. Returns { stack, services: [{name, stopped}] }. */
async function downStack(workspaceDir, ref) {
  const { stack, plan } = resolve(workspaceDir, ref);
  const services = [];
  for (const entry of [...plan].reverse().filter((e) => e.runner === 'process')) {
    const { stopped } = processRunner.down(workspaceDir, stack.name, entry.name);
    services.push({ name: entry.name, runner: 'process', stopped });
  }
  if (plan.some((e) => e.runner === 'docker')) {
    const { stopped } = dockerRunner.down(workspaceDir, stack.name);
    services.push({ name: '(docker services)', runner: 'docker', stopped });
  }
  return { stack: stack.name, services };
}

/** Live status. Returns { stack, services: [{name, runner, running, healthy}] }. */
async function statusStack(workspaceDir, ref) {
  const { stack, plan } = resolve(workspaceDir, ref);
  const dockerPs = plan.some((e) => e.runner === 'docker') ? dockerRunner.status(workspaceDir, stack.name) : null;
  const services = [];
  for (const entry of plan) {
    if (entry.runner === 'process') {
      const st = processRunner.status(workspaceDir, stack.name, entry.name);
      let healthy = null;
      if (st.running && entry.health) healthy = await checkOnce(entry.health);
      services.push({ name: entry.name, runner: 'process', running: !!st.running, healthy, url: serviceUrl(entry) });
    } else {
      let running = null; // unknown without a daemon
      if (dockerPs !== null) {
        running = dockerPs.some((r) => (r.Service || r.Name || '').includes(entry.name));
      }
      services.push({ name: entry.name, runner: 'docker', running, healthy: null, url: serviceUrl(entry) });
    }
  }
  return { stack: stack.name, services };
}

/** Last N lines of a process service's log. */
function tailLogs(workspaceDir, ref, serviceName, lines = 30) {
  const { stack, plan } = resolve(workspaceDir, ref);
  const entry = plan.find((e) => e.name === serviceName);
  if (!entry) throw new Error(`No service "${serviceName}" in stack "${stack.name}"`);
  if (entry.runner === 'docker') throw new Error('Log tailing for docker services needs a docker daemon — use: docker compose logs');
  const file = processRunner.logFile(workspaceDir, stack.name, serviceName);
  if (!fs.existsSync(file)) return '(no logs yet)';
  const content = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  return content.slice(-lines).join('\n');
}

module.exports = { listStacks, upStack, downStack, statusStack, tailLogs, findStackFile };
