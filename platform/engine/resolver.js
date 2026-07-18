/**
 * Stack resolver — turns a stack file + plugin registry into an ordered,
 * fully-interpolated launch plan.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { interpolate } = require('./interpolate');

function loadStack(stackPath) {
  const raw = JSON.parse(fs.readFileSync(stackPath, 'utf8'));
  if (!raw.name) raw.name = path.basename(stackPath).replace(/\.json$/, '');
  if (!raw.services || typeof raw.services !== 'object' || !Object.keys(raw.services).length) {
    throw new Error(`Stack "${raw.name}" defines no services`);
  }
  return raw;
}

function topoSort(services) {
  const order = [];
  const state = new Map(); // name -> 'visiting' | 'done'

  function visit(name, chain) {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      throw new Error(`Dependency cycle: ${[...chain, name].join(' -> ')}`);
    }
    const svc = services[name];
    if (!svc) {
      throw new Error(`Service "${chain[chain.length - 1]}" depends on unknown service "${name}"`);
    }
    state.set(name, 'visiting');
    for (const dep of svc.dependsOn || []) visit(dep, [...chain, name]);
    state.set(name, 'done');
    order.push(name);
  }

  for (const name of Object.keys(services)) visit(name, []);
  return order;
}

/**
 * Resolve a stack into launch plan entries:
 * { name, plugin (manifest), config (interpolated), dependsOn, runner }
 */
function resolveStack(stackPath, registry) {
  const stack = loadStack(stackPath);
  const stackDir = path.dirname(path.resolve(stackPath));
  const order = topoSort(stack.services);

  const resolved = {}; // name -> { config } — made available for ${service.x.y} refs
  const plan = [];

  for (const name of order) {
    const svc = stack.services[name];
    const plugin = registry.get(svc.plugin);
    if (!plugin) {
      const known = [...registry.keys()].sort().join(', ');
      throw new Error(`Service "${name}" uses unknown plugin "${svc.plugin}". Known plugins: ${known}`);
    }

    // Base config: plugin defaults <- stack-level service config
    const config = {
      ...(plugin.defaults || {}),
      ...(svc.config || {}),
      serviceName: name,
      stackName: stack.name,
      stackDir,
      pluginDir: plugin.dir,
    };

    const context = { name, config, services: resolved };
    const finalConfig = interpolate(config, context);
    resolved[name] = { config: finalConfig };

    plan.push({
      name,
      plugin,
      runner: plugin.runner,
      dependsOn: svc.dependsOn || [],
      config: finalConfig,
      // Interpolated copies of runtime sections
      command: plugin.command ? interpolate(plugin.command, { name, config: finalConfig, services: resolved }) : undefined,
      // Plugin-declared env, overridable/extendable per-service via config.env in the stack file
      env: {
        ...(plugin.env ? interpolate(plugin.env, { name, config: finalConfig, services: resolved }) : {}),
        ...(finalConfig.env || {}),
      },
      docker: plugin.docker ? interpolate(plugin.docker, { name, config: finalConfig, services: resolved }) : undefined,
      health: plugin.health ? interpolate(plugin.health, { name, config: finalConfig, services: resolved }) : undefined,
    });
  }

  return { stack, stackDir, plan };
}

module.exports = { resolveStack, topoSort, loadStack };
