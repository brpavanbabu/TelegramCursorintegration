'use strict';

/**
 * Sentinel Test Framework — Test Runner
 *
 * describe/it registration, nested suites, before/after hooks, per-test
 * timeouts and retries, only/skip/todo, requirement tagging (`reqs`) for
 * traceability, and structured results for the reporters.
 */

const path = require('path');

const DEFAULT_TIMEOUT = 5000;

class Suite {
  constructor(name, parent, opts = {}) {
    this.name = name;
    this.parent = parent;
    this.opts = opts;
    this.children = [];
    this.tests = [];
    this.beforeAll = [];
    this.afterAll = [];
    this.beforeEach = [];
    this.afterEach = [];
    this.only = !!opts.only;
    this.skip = !!opts.skip;
    this.file = opts.file || null;
  }

  get fullName() {
    const names = [];
    let s = this;
    while (s && s.name) {
      names.unshift(s.name);
      s = s.parent;
    }
    return names.join(' > ');
  }

  ancestry() {
    const chain = [];
    let s = this;
    while (s) {
      chain.unshift(s);
      s = s.parent;
    }
    return chain;
  }

  inheritedReqs() {
    const reqs = [];
    for (const s of this.ancestry()) {
      if (s.opts && Array.isArray(s.opts.reqs)) reqs.push(...s.opts.reqs);
    }
    return reqs;
  }
}

class Registry {
  constructor() {
    this.reset();
  }

  reset() {
    this.root = new Suite('', null);
    this.current = this.root;
    this.hasOnly = false;
    this.currentFile = null;
  }

  describe(name, fnOrOpts, maybeFn) {
    const opts = typeof fnOrOpts === 'object' && fnOrOpts !== null ? fnOrOpts : {};
    const fn = typeof fnOrOpts === 'function' ? fnOrOpts : maybeFn;
    const suite = new Suite(String(name), this.current, { ...opts, file: this.currentFile });
    if (opts.only) this.hasOnly = true;
    this.current.children.push(suite);
    const prev = this.current;
    this.current = suite;
    try {
      if (typeof fn === 'function') fn();
    } finally {
      this.current = prev;
    }
    return suite;
  }

  it(name, fnOrOpts, maybeOpts) {
    let fn = fnOrOpts;
    let opts = maybeOpts || {};
    if (typeof fnOrOpts === 'object' && fnOrOpts !== null) {
      opts = fnOrOpts;
      fn = maybeOpts;
    }
    const test = {
      name: String(name),
      fn: typeof fn === 'function' ? fn : null,
      opts,
      suite: this.current,
      file: this.currentFile,
      only: !!opts.only,
      skip: !!opts.skip || typeof fn !== 'function',
      todo: !!opts.todo,
    };
    if (test.only) this.hasOnly = true;
    this.current.tests.push(test);
    return test;
  }
}

const registry = new Registry();

function describe(name, fnOrOpts, maybeFn) {
  return registry.describe(name, fnOrOpts, maybeFn);
}
describe.only = (name, fnOrOpts, maybeFn) => {
  const opts = typeof fnOrOpts === 'object' && fnOrOpts !== null ? fnOrOpts : {};
  const fn = typeof fnOrOpts === 'function' ? fnOrOpts : maybeFn;
  return registry.describe(name, { ...opts, only: true }, fn);
};
describe.skip = (name, fnOrOpts, maybeFn) => {
  const opts = typeof fnOrOpts === 'object' && fnOrOpts !== null ? fnOrOpts : {};
  const fn = typeof fnOrOpts === 'function' ? fnOrOpts : maybeFn;
  return registry.describe(name, { ...opts, skip: true }, fn);
};

function it(name, fnOrOpts, maybeOpts) {
  return registry.it(name, fnOrOpts, maybeOpts);
}
it.only = (name, fn, opts = {}) => registry.it(name, fn, { ...opts, only: true });
it.skip = (name, fn, opts = {}) => registry.it(name, fn, { ...opts, skip: true });
it.todo = (name) => registry.it(name, null, { todo: true, skip: true });

const test = it;

function beforeAll(fn) {
  registry.current.beforeAll.push(fn);
}
function afterAll(fn) {
  registry.current.afterAll.push(fn);
}
function beforeEach(fn) {
  registry.current.beforeEach.push(fn);
}
function afterEach(fn) {
  registry.current.afterEach.push(fn);
}

/* ------------------------------------------------------------------ */

function withTimeout(fn, ms, label) {
  return new Promise((resolve, reject) => {
    let finished = false;
    // Deliberately NOT unref'd: if a test hangs with an otherwise-empty event
    // loop, this timer must keep the process alive so the timeout fires and
    // the test FAILS — instead of Node exiting silently with code 0.
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        reject(new Error(`Timeout: ${label} exceeded ${ms}ms`));
      }
    }, ms);
    Promise.resolve()
      .then(() => fn())
      .then(
        (v) => {
          if (!finished) {
            finished = true;
            clearTimeout(timer);
            resolve(v);
          }
        },
        (e) => {
          if (!finished) {
            finished = true;
            clearTimeout(timer);
            reject(e);
          }
        }
      );
  });
}

function serializeError(err) {
  if (!err) return { message: 'Unknown error' };
  const out = {
    name: err.name || 'Error',
    message: err.message !== undefined ? String(err.message) : String(err),
  };
  if (err.stack) {
    out.stack = String(err.stack)
      .split('\n')
      .filter((line) => !line.includes(`testframework${path.sep}core${path.sep}`))
      .slice(0, 12)
      .join('\n');
  }
  if ('actual' in err) out.actual = safeString(err.actual);
  if ('expected' in err) out.expected = safeString(err.expected);
  return out;
}

function safeString(v) {
  try {
    return require('util').inspect(v, { depth: 3, maxStringLength: 200 });
  } catch (e) {
    return String(v);
  }
}

class Runner {
  constructor(options = {}) {
    this.options = options;
    this.results = [];
    this.bailed = false;
  }

  _shouldRun(testCase) {
    if (this.bailed) return false;
    if (registry.hasOnly && !testCase.only && !testCase.suite.ancestry().some((s) => s.only)) return false;
    if (this.options.filter) {
      const full = `${testCase.suite.fullName} > ${testCase.name}`.toLowerCase();
      if (!full.includes(String(this.options.filter).toLowerCase())) return false;
    }
    return true;
  }

  async run() {
    this.startedAt = Date.now();
    await this._runSuite(registry.root, false);
    const duration = Date.now() - this.startedAt;
    const summary = {
      total: this.results.length,
      passed: this.results.filter((r) => r.status === 'passed').length,
      failed: this.results.filter((r) => r.status === 'failed').length,
      skipped: this.results.filter((r) => r.status === 'skipped').length,
      todo: this.results.filter((r) => r.status === 'todo').length,
      duration,
    };
    return { tests: this.results, summary, startedAt: this.startedAt };
  }

  _suiteHasRunnableTests(suite) {
    return (
      suite.tests.some((t) => this._shouldRun(t) && !t.skip) ||
      suite.children.some((c) => this._suiteHasRunnableTests(c))
    );
  }

  async _runSuite(suite, ancestorFailed) {
    let suiteFailed = ancestorFailed;
    let hookError = null;

    const willRunSomething = this._suiteHasRunnableTests(suite);

    if (!suiteFailed && willRunSomething) {
      for (const hook of suite.beforeAll) {
        try {
          await withTimeout(hook, this.options.hookTimeout || DEFAULT_TIMEOUT, `beforeAll in "${suite.fullName}"`);
        } catch (err) {
          suiteFailed = true;
          hookError = err;
          break;
        }
      }
    }

    for (const testCase of suite.tests) {
      await this._runTest(testCase, suiteFailed ? hookError || new Error('suite setup failed') : null);
    }

    for (const child of suite.children) {
      await this._runSuite(child, suiteFailed);
    }

    if (willRunSomething) {
      for (const hook of suite.afterAll) {
        try {
          await withTimeout(hook, this.options.hookTimeout || DEFAULT_TIMEOUT, `afterAll in "${suite.fullName}"`);
        } catch (err) {
          this.results.push({
            suite: suite.fullName,
            name: `afterAll hook`,
            fullName: `${suite.fullName} > afterAll hook`,
            status: 'failed',
            error: serializeError(err),
            duration: 0,
            reqs: [],
            file: suite.file,
          });
        }
      }
    }
  }

  async _runTest(testCase, suiteError) {
    const suite = testCase.suite;
    const fullName = suite.fullName ? `${suite.fullName} > ${testCase.name}` : testCase.name;
    const reqs = [...suite.inheritedReqs(), ...(Array.isArray(testCase.opts.reqs) ? testCase.opts.reqs : [])];

    const record = {
      suite: suite.fullName,
      name: testCase.name,
      fullName,
      status: 'skipped',
      error: null,
      duration: 0,
      retries: 0,
      reqs,
      file: testCase.file,
    };

    if (testCase.todo) {
      record.status = 'todo';
      this.results.push(record);
      return;
    }
    if (!this._shouldRun(testCase) || testCase.skip || suite.ancestry().some((s) => s.skip)) {
      this.results.push(record);
      return;
    }
    if (suiteError) {
      record.status = 'failed';
      record.error = serializeError(new Error(`Suite setup failed: ${suiteError.message}`));
      this.results.push(record);
      return;
    }

    const timeout = testCase.opts.timeout || this.options.timeout || DEFAULT_TIMEOUT;
    const maxRetries = testCase.opts.retries || 0;
    const chain = suite.ancestry();

    let attempt = 0;
    for (;;) {
      const start = Date.now();
      let error = null;
      try {
        for (const s of chain) {
          for (const hook of s.beforeEach) {
            await withTimeout(hook, timeout, `beforeEach in "${s.fullName || '(root)'}"`);
          }
        }
        await withTimeout(testCase.fn, timeout, `test "${fullName}"`);
      } catch (err) {
        error = err;
      } finally {
        for (const s of [...chain].reverse()) {
          for (const hook of s.afterEach) {
            try {
              await withTimeout(hook, timeout, `afterEach in "${s.fullName || '(root)'}"`);
            } catch (hookErr) {
              if (!error) error = hookErr;
            }
          }
        }
      }
      record.duration = Date.now() - start;

      if (!error) {
        record.status = 'passed';
        record.retries = attempt;
        break;
      }
      if (attempt < maxRetries) {
        attempt++;
        continue;
      }
      record.status = 'failed';
      record.retries = attempt;
      record.error = serializeError(error);
      break;
    }

    this.results.push(record);
    if (record.status === 'failed' && this.options.bail) this.bailed = true;
  }
}

/**
 * Load test files (they self-register via describe/it) and run everything.
 */
async function runFiles(files, options = {}) {
  registry.reset();
  const loadErrors = [];
  for (const file of files) {
    const resolved = path.resolve(file);
    registry.currentFile = resolved;
    // Implicit per-file suite so root-level hooks in one file never leak
    // into another file's tests.
    const fileSuite = new Suite(path.basename(file), registry.root, { file: resolved });
    registry.root.children.push(fileSuite);
    registry.current = fileSuite;
    try {
      delete require.cache[require.resolve(resolved)];
      require(resolved);
    } catch (err) {
      loadErrors.push({ file, error: serializeError(err) });
    } finally {
      registry.current = registry.root;
    }
  }
  registry.currentFile = null;
  const runner = new Runner(options);
  const report = await runner.run();
  report.loadErrors = loadErrors;
  if (loadErrors.length > 0) {
    report.summary.failed += loadErrors.length;
    report.summary.total += loadErrors.length;
    for (const le of loadErrors) {
      report.tests.push({
        suite: '(file load)',
        name: le.file,
        fullName: `(file load) > ${le.file}`,
        status: 'failed',
        error: le.error,
        duration: 0,
        reqs: [],
        file: le.file,
      });
    }
  }
  return report;
}

module.exports = {
  describe,
  it,
  test,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  runFiles,
  registry,
  Runner,
  DEFAULT_TIMEOUT,
};
