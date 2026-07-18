#!/usr/bin/env node
/**
 * PlugStack — pluggable, one-click app stacks.
 *
 *   node platform/cli.js list                     # show available plugins
 *   node platform/cli.js up <stack.json>          # one click: start everything
 *   node platform/cli.js down <stack.json>        # stop everything
 *   node platform/cli.js status <stack.json>      # what's running / healthy
 *   node platform/cli.js logs <stack.json> <svc>  # tail a service's logs
 *   node platform/cli.js generate <stack.json>    # emit docker-compose only
 *   node platform/cli.js init plugin <name>       # scaffold a new plugin
 *   node platform/cli.js doctor                   # environment check
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadRegistry } = require('./engine/registry');
const { resolveStack } = require('./engine/resolver');
const { waitHealthy, checkOnce } = require('./engine/health');
const processRunner = require('./engine/runners/process-runner');
const dockerRunner = require('./engine/runners/docker-runner');
const { readState } = require('./engine/state');

const WORKSPACE = process.cwd();

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function findStackFile(arg) {
  if (!arg) {
    const candidates = ['stack.json', path.join('stacks', 'stack.json')];
    for (const cand of candidates) {
      if (fs.existsSync(path.join(WORKSPACE, cand))) return path.join(WORKSPACE, cand);
    }
    fail('No stack file given and no ./stack.json found. Usage: up <path/to/stack.json>');
  }
  const tries = [arg, `${arg}.json`, path.join('stacks', arg), path.join('stacks', `${arg}.json`)];
  for (const t of tries) {
    const full = path.resolve(WORKSPACE, t);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  fail(`Stack file not found: ${arg} (tried ${tries.join(', ')})`);
}

function fail(msg) {
  console.error(c.red(`✖ ${msg}`));
  process.exit(1);
}

function serviceUrl(entry) {
  const port = entry.config.port;
  if (!port) return null;
  const proto = entry.health && entry.health.type === 'http' ? 'http' : 'tcp';
  return proto === 'http' ? `http://localhost:${port}` : `localhost:${port}`;
}

// ---------------------------------------------------------------- commands

function cmdList() {
  const registry = loadRegistry(WORKSPACE);
  console.log(c.bold('\nAvailable plugins:\n'));
  const rows = [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const p of rows) {
    const runner = p.runner === 'docker' ? c.cyan('[docker] ') : c.green('[process]');
    console.log(`  ${runner} ${c.bold(p.name.padEnd(18))} ${p.kind ? c.dim(`(${p.kind}) `) : ''}${p.description || ''}`);
  }
  console.log(c.dim('\nAdd your own: node platform/cli.js init plugin <name>  (creates ./plugins/<name>/)\n'));
}

async function cmdUp(stackArg) {
  const stackPath = findStackFile(stackArg);
  const registry = loadRegistry(WORKSPACE);
  const { stack, plan } = resolveStack(stackPath, registry);

  console.log(c.bold(`\n🚀 Bringing up stack "${stack.name}" (${plan.length} services)\n`));

  const dockerEntries = plan.filter((e) => e.runner === 'docker');
  const started = [];

  // Phase 1: all docker services in one compose project
  if (dockerEntries.length) {
    process.stdout.write(`  ${c.cyan('[docker]')} ${dockerEntries.map((e) => e.name).join(', ')} ... `);
    try {
      const { composeFile } = dockerRunner.up(WORKSPACE, stack.name, dockerEntries);
      console.log(c.green('up'));
      console.log(c.dim(`           compose: ${path.relative(WORKSPACE, composeFile)}`));
    } catch (err) {
      if (err.daemonMissing) {
        console.log(c.yellow('skipped (no docker daemon)'));
        console.log(c.yellow(`  ⚠ ${err.message}`));
      } else {
        fail(`docker services failed: ${err.message}`);
      }
    }
  }

  // Phase 2: process services in dependency order, waiting for health
  for (const entry of plan.filter((e) => e.runner === 'process')) {
    process.stdout.write(`  ${c.green('[process]')} ${entry.name.padEnd(16)} `);
    const { pid, alreadyRunning } = processRunner.up(WORKSPACE, stack.name, entry);
    if (alreadyRunning) {
      console.log(c.yellow(`already running (pid ${pid})`));
      continue;
    }
    process.stdout.write(c.dim(`pid ${pid} `));
    const healthy = await waitHealthy(entry.health, {
      timeoutMs: Number(entry.config.healthTimeoutMs || 30000),
      onTick: () => process.stdout.write(c.dim('.')),
    });
    if (healthy) {
      console.log(` ${c.green('healthy')}`);
    } else {
      console.log(` ${c.red('NOT healthy')}`);
      console.log(c.red(`    Check logs: node platform/cli.js logs ${stackArg || stack.name} ${entry.name}`));
    }
    started.push(entry);
  }

  console.log(c.bold('\n✅ Stack is up.\n'));
  for (const entry of plan) {
    const url = serviceUrl(entry);
    if (url) console.log(`   ${entry.name.padEnd(16)} ${c.cyan(url)}`);
  }
  console.log(c.dim(`\n   status: node platform/cli.js status ${stackArg || ''}`));
  console.log(c.dim(`   stop:   node platform/cli.js down ${stackArg || ''}\n`));
}

async function cmdDown(stackArg) {
  const stackPath = findStackFile(stackArg);
  const registry = loadRegistry(WORKSPACE);
  const { stack, plan } = resolveStack(stackPath, registry);

  console.log(c.bold(`\n🛑 Bringing down stack "${stack.name}"\n`));

  // Stop process services in reverse dependency order
  for (const entry of [...plan].reverse().filter((e) => e.runner === 'process')) {
    const { stopped } = processRunner.down(WORKSPACE, stack.name, entry.name);
    console.log(`  ${c.green('[process]')} ${entry.name.padEnd(16)} ${stopped ? c.green('stopped') : c.dim('not running')}`);
  }
  if (plan.some((e) => e.runner === 'docker')) {
    const { stopped } = dockerRunner.down(WORKSPACE, stack.name);
    console.log(`  ${c.cyan('[docker]')} compose project    ${stopped ? c.green('stopped') : c.dim('not running / no daemon')}`);
  }
  console.log('');
}

async function cmdStatus(stackArg) {
  const stackPath = findStackFile(stackArg);
  const registry = loadRegistry(WORKSPACE);
  const { stack, plan } = resolveStack(stackPath, registry);

  console.log(c.bold(`\nStack "${stack.name}"\n`));
  const dockerPs = plan.some((e) => e.runner === 'docker') ? dockerRunner.status(WORKSPACE, stack.name) : null;

  for (const entry of plan) {
    if (entry.runner === 'process') {
      const st = processRunner.status(WORKSPACE, stack.name, entry.name);
      let health = '';
      if (st.running && entry.health) {
        const ok = await checkOnce(entry.health);
        health = ok === null ? '' : ok ? c.green(' healthy') : c.red(' unhealthy');
      }
      const stateStr = st.running ? c.green(`running (pid ${st.pid})`) : c.red('stopped');
      console.log(`  ${entry.name.padEnd(16)} ${stateStr}${health}`);
    } else {
      let stateStr;
      if (dockerPs === null) stateStr = c.yellow('unknown (no docker daemon)');
      else {
        const row = dockerPs.find((r) => (r.Service || r.Name || '').includes(entry.name));
        stateStr = row ? c.green(row.State || 'running') : c.red('not running');
      }
      console.log(`  ${entry.name.padEnd(16)} ${stateStr} ${c.dim('[docker]')}`);
    }
  }
  console.log('');
}

function cmdLogs(stackArg, serviceName, extra) {
  if (!serviceName) fail('Usage: logs <stack> <service> [-f]');
  const stackPath = findStackFile(stackArg);
  const { stack, plan } = resolveStack(stackPath, loadRegistry(WORKSPACE));
  const entry = plan.find((e) => e.name === serviceName);
  if (!entry) fail(`No service "${serviceName}" in stack "${stack.name}"`);

  if (entry.runner === 'docker') {
    const res = spawnSync('docker', ['compose', '-p', stack.name, 'logs', '--tail', '100', serviceName], { stdio: 'inherit' });
    if (res.status !== 0) fail('Could not fetch docker logs (is the daemon running?)');
    return;
  }
  const file = processRunner.logFile(WORKSPACE, stack.name, serviceName);
  if (!fs.existsSync(file)) fail(`No logs yet at ${file}`);
  const follow = extra === '-f' || extra === '--follow';
  spawnSync('tail', [follow ? '-f' : '-n', follow ? file : '100', ...(follow ? [] : [file])], { stdio: 'inherit' });
}

function cmdGenerate(stackArg) {
  const stackPath = findStackFile(stackArg);
  const { stack, plan } = resolveStack(stackPath, loadRegistry(WORKSPACE));
  const dockerEntries = plan.filter((e) => e.runner === 'docker');
  if (!dockerEntries.length) {
    console.log(c.yellow(`Stack "${stack.name}" has no docker services — nothing to generate.`));
    return;
  }
  const file = dockerRunner.generate(WORKSPACE, stack.name, dockerEntries);
  console.log(c.green(`✔ Wrote ${path.relative(WORKSPACE, file)}`));
  console.log(c.dim(`  Run it anywhere with: docker compose -p ${stack.name} -f ${file} up -d`));
}

function cmdInit(what, name) {
  if (what !== 'plugin' || !name) fail('Usage: init plugin <name>');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail('Plugin name must be lowercase letters, digits, dashes');
  const dir = path.join(WORKSPACE, 'plugins', name);
  if (fs.existsSync(dir)) fail(`${dir} already exists`);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    name,
    kind: 'service',
    runner: 'process',
    description: `TODO: describe the ${name} plugin`,
    defaults: { port: 3000 },
    command: 'node ${pluginDir}/server.js',
    env: { PORT: '${port}' },
    health: { type: 'http', port: '${port}', path: '/' },
  };
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(
    path.join(dir, 'server.js'),
    `const http = require('http');\nconst port = process.env.PORT || 3000;\nhttp.createServer((req, res) => res.end('hello from ${name}')).listen(port, () => console.log('${name} on', port));\n`
  );
  console.log(c.green(`✔ Scaffolded plugin at plugins/${name}/`));
  console.log(c.dim(`  It is now visible in: node platform/cli.js list`));
}

function cmdDoctor() {
  console.log(c.bold('\nEnvironment check:\n'));
  console.log(`  node            ${c.green(process.version)}`);
  const dockerCli = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  console.log(`  docker cli      ${dockerCli.status === 0 ? c.green(dockerCli.stdout.trim()) : c.red('not installed')}`);
  const daemon = dockerRunner.daemonAvailable();
  console.log(`  docker daemon   ${daemon ? c.green('running') : c.yellow('not running (docker plugins will generate compose files only)')}`);
  const registry = loadRegistry(WORKSPACE);
  console.log(`  plugins found   ${c.green(String(registry.size))}`);
  const state = readState(WORKSPACE);
  const running = Object.keys(state.stacks || {});
  console.log(`  active stacks   ${running.length ? c.green(running.join(', ')) : c.dim('none')}\n`);
}

// ---------------------------------------------------------------- dispatch

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'list': return cmdList();
      case 'up': return await cmdUp(args[0]);
      case 'down': return await cmdDown(args[0]);
      case 'status': return await cmdStatus(args[0]);
      case 'logs': return cmdLogs(args[0], args[1], args[2]);
      case 'generate': return cmdGenerate(args[0]);
      case 'init': return cmdInit(args[0], args[1]);
      case 'doctor': return cmdDoctor();
      default:
        console.log(`
${c.bold('PlugStack')} — pluggable, one-click app stacks

  ${c.cyan('list')}                      Show available plugins
  ${c.cyan('up <stack>')}                One click: start every service in the stack
  ${c.cyan('down <stack>')}              Stop every service in the stack
  ${c.cyan('status <stack>')}            Show what is running and healthy
  ${c.cyan('logs <stack> <service>')}    Show a service's logs (-f to follow)
  ${c.cyan('generate <stack>')}          Write the docker-compose file without starting
  ${c.cyan('init plugin <name>')}        Scaffold a new plugin in ./plugins/
  ${c.cyan('doctor')}                    Check the environment

Stacks live in ./stacks/*.json — try: node platform/cli.js up fullstack-demo
`);
    }
  } catch (err) {
    fail(err.message);
  }
}

main();
