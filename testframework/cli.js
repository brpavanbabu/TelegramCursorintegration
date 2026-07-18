#!/usr/bin/env node
'use strict';

/**
 * Sentinel Test Framework — CLI
 *
 * Autonomous, requirement-driven testing for ANY Node.js project.
 *
 *   node testframework/cli.js <command> [options]
 *
 * Commands:
 *   all        run the full pipeline: analyze + tests + coverage + fuzz + requirements  (default)
 *   run        run the test suites only
 *   analyze    static & security analysis only
 *   generate   auto-discover modules, fuzz them; --write pins regression suites
 *   matrix     evaluate the requirements traceability matrix
 *   discover   show what the framework auto-detected in this project
 *   init       bootstrap config + requirements skeleton in any project
 *
 * Options:
 *   --root=DIR         project root (default: cwd or config location)
 *   --filter=TEXT      only run tests whose full name contains TEXT
 *   --bail             stop at first test failure
 *   --verbose          verbose output
 *   --seed=N           fuzzer seed (deterministic)
 *   --strict           high-severity findings & fuzz crashes fail the run
 *   --no-coverage      skip coverage collection
 *   --write            (generate) write pinned regression suites to tests/generated/
 *   --json=FILE        write JSON report
 *   --junit=FILE       write JUnit XML report
 *   --html=FILE        write HTML report
 *   --out-dir=DIR      directory for default report files (default: .testreports)
 */

const fs = require('fs');
const path = require('path');

const { runFiles } = require('./core/runner');
const { CoverageCollector } = require('./core/coverage');
const analyzer = require('./analysis/static');
const autogen = require('./autogen/generator');
const reqEngine = require('./requirements/engine');
const consoleReporter = require('./reporters/console');
const jsonReporter = require('./reporters/json');
const junitReporter = require('./reporters/junit');
const htmlReporter = require('./reporters/html');

/* ---------------- argument parsing ---------------- */

function parseArgs(argv) {
  const args = { _: [] };
  for (const raw of argv) {
    if (raw.startsWith('--')) {
      const eq = raw.indexOf('=');
      if (eq === -1) args[raw.slice(2)] = true;
      else args[raw.slice(2, eq)] = raw.slice(eq + 1);
    } else {
      args._.push(raw);
    }
  }
  return args;
}

/* ---------------- configuration ---------------- */

const DEFAULT_CONFIG = {
  testDir: 'tests',
  testMatch: '\\.test\\.js$',
  requirements: 'requirements/requirements.json',
  coverage: {
    exclude: ['^testframework/', '^tests/', '\\.test\\.js$', '^requirements/'],
  },
  fuzz: {
    seed: 42,
    iterations: 120,
    targets: [],
  },
  analyze: {
    excludeDirs: [],
    excludeFiles: [],
  },
  productFiles: [],
};

function loadConfig(root) {
  const configPath = path.join(root, 'testframework.config.json');
  if (!fs.existsSync(configPath)) return { ...DEFAULT_CONFIG, _configPath: null };
  const user = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return {
    ...DEFAULT_CONFIG,
    ...user,
    coverage: { ...DEFAULT_CONFIG.coverage, ...(user.coverage || {}) },
    fuzz: { ...DEFAULT_CONFIG.fuzz, ...(user.fuzz || {}) },
    analyze: { ...DEFAULT_CONFIG.analyze, ...(user.analyze || {}) },
    _configPath: configPath,
  };
}

function findTestFiles(root, config) {
  const dir = path.resolve(root, config.testDir);
  if (!fs.existsSync(dir)) return [];
  const matcher = new RegExp(config.testMatch);
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (matcher.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

function discoverProductFiles(root, config) {
  if (config.productFiles && config.productFiles.length) return config.productFiles.map((f) => path.resolve(root, f));
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) out.push(path.join(root, entry.name));
    if (entry.isDirectory() && ['src', 'lib', 'app'].includes(entry.name)) {
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory() && e.name !== 'node_modules') walk(full);
          else if (e.isFile() && e.name.endsWith('.js')) out.push(full);
        }
      };
      walk(path.join(root, entry.name));
    }
  }
  return out.filter((f) => {
    const rel = path.relative(root, f);
    return !rel.startsWith('testframework') && !rel.startsWith('tests') && !rel.includes('node_modules');
  });
}

/* ---------------- pipeline stages ---------------- */

async function stageAnalyze(root, config) {
  return analyzer.scan(root, config.analyze);
}

async function stageTests(root, config, args, coverage) {
  const files = findTestFiles(root, config);
  if (coverage) await coverage.start();
  const report = await runFiles(files, {
    filter: args.filter,
    bail: !!args.bail,
    timeout: config.timeout,
  });
  return { report, files };
}

async function stageFuzz(root, config, args) {
  return autogen.fuzzProject(root, {
    seed: Number(args.seed || config.fuzz.seed),
    iterations: Number(config.fuzz.iterations),
    targets: config.fuzz.targets && config.fuzz.targets.length ? config.fuzz.targets : undefined,
    excludeDirs: config.analyze.excludeDirs,
  });
}

async function stageMatrix(root, config, testResults, analysis) {
  const reqPath = path.resolve(root, config.requirements);
  if (!fs.existsSync(reqPath)) return null;
  const doc = reqEngine.loadRequirements(reqPath);
  return reqEngine.evaluate(doc, testResults, { root, analysis });
}

function computeVerdict({ testReport, matrix, analysis, fuzz }, strict) {
  const reasons = [];
  let pass = true;

  if (testReport) {
    const ok = testReport.summary.failed === 0;
    reasons.push({ ok, text: `test suites: ${testReport.summary.passed}/${testReport.summary.total} passed${ok ? '' : ` — ${testReport.summary.failed} FAILED`}` });
    pass = pass && ok;
  }
  if (matrix) {
    const ok = matrix.summary.fail === 0;
    reasons.push({ ok, text: `requirements: ${matrix.summary.pass} pass, ${matrix.summary.fail} fail, ${matrix.summary.uncovered} uncovered` });
    pass = pass && ok;
  }
  if (analysis) {
    const high = analysis.counts.high;
    const ok = strict ? high === 0 : true;
    reasons.push({
      ok,
      text: `security findings: ${high} high, ${analysis.counts.medium} medium${strict ? ' (strict: high findings fail the run)' : high > 0 ? ' — review required (use --strict to enforce)' : ''}`,
    });
    pass = pass && ok;
  }
  if (fuzz) {
    const crashes = fuzz.reports.reduce((n, r) => n + r.totalCrashSignatures, 0);
    const polluted = fuzz.reports.some((r) => r.prototypePolluted);
    const ok = strict ? crashes === 0 && !polluted : !polluted;
    reasons.push({
      ok,
      text: `autonomous fuzzing: ${fuzz.reports.reduce((n, r) => n + r.totalInvocations, 0)} calls, ${crashes} crash signature(s)${polluted ? ', PROTOTYPE POLLUTION' : ''}${strict ? ' (strict)' : ''}`,
    });
    pass = pass && ok;
  }
  return { pass, reasons };
}

function writeReports(root, args, fullReport) {
  const outDir = path.resolve(root, args['out-dir'] || '.testreports');
  const targets = {
    json: args.json === true ? path.join(outDir, 'report.json') : args.json,
    junit: args.junit === true ? path.join(outDir, 'junit.xml') : args.junit,
    html: args.html === true ? path.join(outDir, 'report.html') : args.html,
  };
  const written = [];
  if (targets.json) written.push(jsonReporter.write(fullReport, path.resolve(root, targets.json)));
  if (targets.junit && fullReport.tests) written.push(junitReporter.write(fullReport.tests, path.resolve(root, targets.junit)));
  if (targets.html) written.push(htmlReporter.write(fullReport, path.resolve(root, targets.html)));
  for (const file of written) console.log(`  report written: ${path.relative(root, file)}`);
}

/* ---------------- commands ---------------- */

async function cmdAll(root, config, args) {
  const strict = !!args.strict;
  const analysis = await stageAnalyze(root, config);

  const coverage = args.coverage === false || args['no-coverage'] ? null : new CoverageCollector(root, { exclude: config.coverage.exclude.map((p) => new RegExp(p)) });
  const { report: testReport } = await stageTests(root, config, args, coverage);
  let coverageSummary = null;
  if (coverage) {
    const v8 = await coverage.stop();
    coverageSummary = coverage.summarize(v8, discoverProductFiles(root, config));
  }

  const fuzz = await stageFuzz(root, config, args);
  const matrix = await stageMatrix(root, config, testReport.tests, analysis);
  const verdict = computeVerdict({ testReport, matrix, analysis, fuzz }, strict);

  consoleReporter.reportAnalysis(analysis);
  consoleReporter.reportTests(testReport, { verbose: !!args.verbose });
  if (coverageSummary) consoleReporter.reportCoverage(coverageSummary);
  consoleReporter.reportFuzz(fuzz);
  if (matrix) consoleReporter.reportMatrix(matrix);
  consoleReporter.reportVerdict(verdict);

  const fullReport = {
    project: (matrix && matrix.project) || path.basename(root),
    generatedAt: new Date().toISOString(),
    verdict,
    tests: testReport,
    coverage: coverageSummary,
    analysis,
    fuzz,
    matrix,
  };
  writeReports(root, args, fullReport);
  return verdict.pass ? 0 : 1;
}

async function cmdRun(root, config, args) {
  const coverage = args.coverage === false || args['no-coverage'] ? null : new CoverageCollector(root, { exclude: config.coverage.exclude.map((p) => new RegExp(p)) });
  const { report: testReport, files } = await stageTests(root, config, args, coverage);
  if (files.length === 0) console.log('No test files found in ' + path.resolve(root, config.testDir));
  let coverageSummary = null;
  if (coverage) {
    const v8 = await coverage.stop();
    coverageSummary = coverage.summarize(v8, discoverProductFiles(root, config));
  }
  consoleReporter.reportTests(testReport, { verbose: !!args.verbose });
  if (coverageSummary) consoleReporter.reportCoverage(coverageSummary);
  writeReports(root, args, { project: path.basename(root), generatedAt: new Date().toISOString(), tests: testReport, coverage: coverageSummary });
  return testReport.summary.failed === 0 ? 0 : 1;
}

async function cmdAnalyze(root, config, args) {
  const analysis = await stageAnalyze(root, config);
  consoleReporter.reportAnalysis(analysis);
  writeReports(root, args, { project: path.basename(root), generatedAt: new Date().toISOString(), analysis });
  return args.strict && analysis.counts.high > 0 ? 1 : 0;
}

async function cmdGenerate(root, config, args) {
  const fuzz = await stageFuzz(root, config, args);
  consoleReporter.reportFuzz(fuzz);
  if (args.write) {
    for (const report of fuzz.reports) {
      const base = path.basename(report.module, '.js');
      const outFile = path.resolve(root, config.testDir, 'generated', `${base}.autogen.test.js`);
      const { cases } = await autogen.writeRegressionSuite(root, report.module, outFile);
      console.log(`  pinned ${cases} edge-case behaviors -> ${path.relative(root, outFile)}`);
    }
  }
  const crashes = fuzz.reports.reduce((n, r) => n + r.totalCrashSignatures, 0);
  return args.strict && crashes > 0 ? 1 : 0;
}

async function cmdMatrix(root, config, args) {
  const analysis = await stageAnalyze(root, config);
  const { report: testReport } = await stageTests(root, config, args, null);
  const matrix = await stageMatrix(root, config, testReport.tests, analysis);
  if (!matrix) {
    console.error(`No requirements file at ${config.requirements}. Run "init" to create one.`);
    return 1;
  }
  consoleReporter.reportMatrix(matrix);
  return matrix.summary.fail === 0 ? 0 : 1;
}

async function cmdDiscover(root, config) {
  console.log(`\nProject root: ${root}`);
  const tests = findTestFiles(root, config);
  console.log(`\nTest files (${tests.length}):`);
  for (const t of tests) console.log('  - ' + path.relative(root, t));
  const products = discoverProductFiles(root, config);
  console.log(`\nProduct files (${products.length}):`);
  for (const p of products) console.log('  - ' + path.relative(root, p));
  const { targets, skipped } = autogen.discoverTargets(root, config.analyze);
  console.log(`\nAuto-fuzzable modules (${targets.length}):`);
  for (const t of targets) console.log(`  - ${t.file} (functions: ${t.functions.join(', ')})`);
  console.log(`\nModules needing stubs or skipped (${skipped.length}):`);
  for (const s of skipped) console.log(`  - ${s.file}: ${s.reason}`);
  const reqPath = path.resolve(root, config.requirements);
  console.log(`\nRequirements file: ${fs.existsSync(reqPath) ? config.requirements : '(none — run "init")'}`);
  return 0;
}

async function cmdInit(root, config) {
  const configPath = path.join(root, 'testframework.config.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          testDir: 'tests',
          requirements: 'requirements/requirements.json',
          coverage: { exclude: ['^testframework/', '^tests/', '^requirements/'] },
          fuzz: { seed: 42, iterations: 120, targets: [] },
        },
        null,
        2
      ) + '\n'
    );
    console.log('created testframework.config.json');
  }
  const reqPath = path.resolve(root, config.requirements);
  if (!fs.existsSync(reqPath)) {
    fs.mkdirSync(path.dirname(reqPath), { recursive: true });
    fs.writeFileSync(
      reqPath,
      JSON.stringify(
        {
          project: path.basename(root),
          requirements: [
            {
              id: 'REQ-001',
              title: 'Example: package.json declares a start script',
              priority: 'medium',
              verify: [{ type: 'package_script', name: 'start' }],
            },
          ],
        },
        null,
        2
      ) + '\n'
    );
    console.log(`created ${config.requirements}`);
  }
  const testDir = path.resolve(root, config.testDir);
  fs.mkdirSync(testDir, { recursive: true });
  const example = path.join(testDir, 'example.test.js');
  if (!fs.existsSync(example) && findTestFiles(root, config).length === 0) {
    fs.writeFileSync(
      example,
      `'use strict';\nconst { describe, it, expect } = require('../testframework');\n\ndescribe('example', () => {\n  it('works', () => {\n    expect(1 + 1).toBe(2);\n  });\n});\n`
    );
    console.log(`created ${path.relative(root, example)}`);
  }
  console.log('\nNext: node testframework/cli.js all');
  return 0;
}

/* ---------------- main ---------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'all';
  const root = path.resolve(args.root || process.cwd());
  const config = loadConfig(root);

  const commands = {
    all: () => cmdAll(root, config, args),
    run: () => cmdRun(root, config, args),
    analyze: () => cmdAnalyze(root, config, args),
    generate: () => cmdGenerate(root, config, args),
    fuzz: () => cmdGenerate(root, config, args),
    matrix: () => cmdMatrix(root, config, args),
    discover: () => cmdDiscover(root, config),
    init: () => cmdInit(root, config),
  };

  if (args.help || command === 'help' || !commands[command]) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1].replace(/^ \* ?/gm, ''));
    process.exit(commands[command] ? 0 : 1);
  }

  const code = await commands[command]();
  process.exit(code);
}

main().catch((err) => {
  console.error('sentinel: fatal error:', err && err.stack ? err.stack : err);
  process.exit(2);
});
