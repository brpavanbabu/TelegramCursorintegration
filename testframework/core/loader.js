'use strict';

/**
 * Sentinel Test Framework — Sandbox Module Loader
 *
 * Loads ANY CommonJS module in an instrumented sandbox so applications with
 * heavy side effects (network clients, native modules, process.exit calls,
 * timers, filesystem access) can be tested end-to-end without their real
 * environment:
 *
 *   - `stubs`   : replace any require()'d dependency by name
 *                 (e.g. 'node-telegram-bot-api', 'robotjs', 'child_process')
 *   - `fs`      : override individual fs methods (existsSync, readFileSync...)
 *   - `process` : process.exit() throws a catchable ExitError instead of
 *                 killing the test run
 *   - `console` : captured, assertable
 *   - `timers`  : injectable (pair with mock.FakeClock for virtual time)
 *   - `Date`    : injectable
 *
 * Every load is a FRESH module instance — no shared state between tests.
 */

const vm = require('vm');
const fsReal = require('fs');
const path = require('path');
const util = require('util');

class ExitError extends Error {
  constructor(code) {
    super(`process.exit(${code}) called`);
    this.name = 'ExitError';
    this.code = code;
  }
}

function createFakeProcess(overrides = {}) {
  const fake = Object.create(process);
  fake.exit = (code = 0) => {
    throw new ExitError(code);
  };
  fake.on = () => fake; // don't register real process listeners from sandboxed code
  fake.once = () => fake;
  Object.assign(fake, overrides);
  return fake;
}

function createConsoleCapture() {
  const entries = [];
  const capture = {};
  for (const level of ['log', 'error', 'warn', 'info', 'debug', 'trace']) {
    capture[level] = (...args) => {
      entries.push({ level, text: util.format(...args) });
    };
  }
  capture.entries = entries;
  capture.output = (level = null) =>
    entries
      .filter((e) => !level || e.level === level)
      .map((e) => e.text)
      .join('\n');
  capture.includes = (needle) => entries.some((e) => e.text.includes(needle));
  return capture;
}

/**
 * Load a CommonJS file inside the sandbox.
 *
 * @param {string} filePath
 * @param {object} opts
 *   - stubs      {object} map of require() specifier -> replacement module
 *   - fs         {object} fs method overrides (merged over real fs)
 *   - process    {object} fake process (default: exit-throws wrapper)
 *   - console    {object} console replacement (default: capture)
 *   - timers     {object} {setTimeout,setInterval,clearTimeout,clearInterval,setImmediate}
 *   - Date       {Function} Date replacement
 *   - sandboxRelative {boolean} load relative requires in the sandbox too
 * @returns {{ exports, console, process, filename }}
 */
function loadSandboxed(filePath, opts = {}) {
  const resolved = path.resolve(filePath);
  let source = fsReal.readFileSync(resolved, 'utf8');
  if (source.startsWith('#!')) source = source.replace(/^#![^\n]*/, '');

  const stubs = opts.stubs || {};
  const fsOverrides = opts.fs || null;
  const fakeConsole = opts.console || createConsoleCapture();
  const fakeProcess = opts.process || createFakeProcess();
  const timers = opts.timers || {};

  const customRequire = (name) => {
    if (Object.prototype.hasOwnProperty.call(stubs, name)) return stubs[name];
    if ((name === 'fs' || name === 'node:fs') && fsOverrides) {
      return { ...fsReal, ...fsOverrides };
    }
    if (name.startsWith('.') || name.startsWith('/')) {
      const target = require.resolve(path.resolve(path.dirname(resolved), name));
      if (Object.prototype.hasOwnProperty.call(stubs, target)) return stubs[target];
      if (opts.sandboxRelative) {
        return loadSandboxed(target, opts).exports;
      }
      return require(target);
    }
    return require(name);
  };
  customRequire.resolve = (name) => {
    if (name.startsWith('.') || name.startsWith('/')) {
      return require.resolve(path.resolve(path.dirname(resolved), name));
    }
    return require.resolve(name);
  };
  customRequire.cache = {};

  const moduleObj = { exports: {}, filename: resolved, id: resolved, loaded: false };

  const params = [
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
    'process',
    'console',
    'setTimeout',
    'setInterval',
    'clearTimeout',
    'clearInterval',
    'setImmediate',
    'Date',
  ];

  const compiled = vm.compileFunction(source, params, { filename: resolved });

  compiled.call(
    moduleObj.exports,
    moduleObj.exports,
    customRequire,
    moduleObj,
    resolved,
    path.dirname(resolved),
    fakeProcess,
    fakeConsole,
    timers.setTimeout || setTimeout,
    timers.setInterval || setInterval,
    timers.clearTimeout || clearTimeout,
    timers.clearInterval || clearInterval,
    timers.setImmediate || setImmediate,
    opts.Date || Date
  );
  moduleObj.loaded = true;

  return {
    exports: moduleObj.exports,
    console: fakeConsole,
    process: fakeProcess,
    filename: resolved,
  };
}

/**
 * Statically list the require() specifiers of a file — used by auto-discovery
 * to decide whether a module is safe to load without stubs.
 */
function listRequires(filePath) {
  const source = fsReal.readFileSync(path.resolve(filePath), 'utf8');
  const specifiers = new Set();
  const re = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(source)) !== null) specifiers.add(m[1]);
  return [...specifiers];
}

const NODE_BUILTINS = new Set(
  require('module').builtinModules.flatMap((name) => [name, `node:${name}`])
);

module.exports = {
  loadSandboxed,
  listRequires,
  createFakeProcess,
  createConsoleCapture,
  ExitError,
  NODE_BUILTINS,
};
