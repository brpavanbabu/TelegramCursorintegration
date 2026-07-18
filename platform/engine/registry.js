/**
 * Plugin registry — discovers plugin manifests.
 *
 * Plugins are directories containing a plugin.json manifest. They are looked
 * up in two places (later wins, so a workspace can override a built-in):
 *   1. platform/plugins/<name>/plugin.json   (built-ins shipped with the repo)
 *   2. ./plugins/<name>/plugin.json          (workspace-local plugins)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RUNNERS = new Set(['process', 'docker']);

function validateManifest(manifest, dir) {
  const problems = [];
  if (!manifest.name || typeof manifest.name !== 'string') problems.push('missing "name"');
  if (!RUNNERS.has(manifest.runner)) problems.push(`"runner" must be one of: ${[...RUNNERS].join(', ')}`);
  if (manifest.runner === 'docker' && !manifest.docker) problems.push('docker plugins need a "docker" section');
  if (manifest.runner === 'process' && !manifest.command) problems.push('process plugins need a "command"');
  if (problems.length) {
    throw new Error(`Invalid plugin manifest in ${dir}: ${problems.join('; ')}`);
  }
}

function loadPluginDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(root, e.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'plugin.json')));
}

function loadRegistry(workspaceDir) {
  const builtinRoot = path.join(__dirname, '..', 'plugins');
  const workspaceRoot = path.join(workspaceDir, 'plugins');
  const plugins = new Map();

  for (const dir of [...loadPluginDirs(builtinRoot), ...loadPluginDirs(workspaceRoot)]) {
    const manifestPath = path.join(dir, 'plugin.json');
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      throw new Error(`Could not parse ${manifestPath}: ${err.message}`);
    }
    validateManifest(manifest, dir);
    plugins.set(manifest.name, { ...manifest, dir });
  }
  return plugins;
}

module.exports = { loadRegistry };
