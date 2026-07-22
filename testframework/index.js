'use strict';

/**
 * Sentinel Test Framework — public API
 *
 * Usage in a test file:
 *   const { describe, it, expect, mock, loadSandboxed } = require('../testframework');
 */

const runner = require('./core/runner');
const { expect, AssertionError, deepEqual } = require('./core/assert');
const mock = require('./core/mock');
const loader = require('./core/loader');
const { FakeTelegramBot } = require('./stubs/telegram-bot');

module.exports = {
  // runner
  describe: runner.describe,
  it: runner.it,
  test: runner.test,
  beforeAll: runner.beforeAll,
  afterAll: runner.afterAll,
  beforeEach: runner.beforeEach,
  afterEach: runner.afterEach,

  // assertions
  expect,
  AssertionError,
  deepEqual,

  // mocks & virtual time
  mock,

  // sandbox loading
  loadSandboxed: loader.loadSandboxed,
  createFakeProcess: loader.createFakeProcess,
  createConsoleCapture: loader.createConsoleCapture,
  ExitError: loader.ExitError,

  // ready-made stubs
  stubs: { FakeTelegramBot },
};
