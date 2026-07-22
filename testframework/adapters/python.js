'use strict';

/**
 * Sentinel Test Framework — Python language adapter
 *
 * Gives Python projects the same autonomous treatment as JavaScript:
 *   - security & quality analysis (regex rules + `python3 -m py_compile`)
 *   - autonomous fuzzing of safely-importable modules via a stdlib-only
 *     harness (AST-screened: stdlib imports only, no top-level side effects)
 *   - test execution via pytest (JUnit XML) or stdlib unittest (JSON),
 *     results merged into Sentinel's unified report; `[REQ-ID]` tags in
 *     test names link into the traceability matrix
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseJUnitFile, extractReqTags } = require('./junit-xml');

const PY_RULES = [
  {
    id: 'py-eval-exec',
    severity: 'high',
    pattern: /\b(eval|exec)\s*\(/g,
    message: 'eval()/exec() enables arbitrary code execution',
  },
  {
    id: 'py-hardcoded-credential',
    severity: 'high',
    pattern: /\b[A-Za-z0-9_.]*(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"]([^'"\n]{6,})['"]/gi,
    filter: (m) => !/your|example|here|change|placeholder|sample|dummy|test[-_]?pass|fake|xxx|[<>]|environ|getenv/i.test(m[2]),
    message: 'Possible hardcoded credential (use environment variables or a secrets manager)',
  },
  {
    id: 'py-shell-injection',
    severity: 'medium',
    pattern: /\bos\.system\s*\(|shell\s*=\s*True/g,
    message: 'Shell execution — prefer subprocess with an argument list and shell=False',
  },
  {
    id: 'py-unsafe-deserialization',
    severity: 'medium',
    pattern: /\bpickle\.loads?\s*\(|\byaml\.load\s*\((?![^)]*SafeLoader)/g,
    message: 'Unsafe deserialization of untrusted data (pickle / yaml.load without SafeLoader)',
  },
  {
    id: 'py-sql-injection-risk',
    severity: 'medium',
    pattern: /\.execute\s*\(\s*(f['"]|['"][^'"]*['"]\s*%|['"][^'"]*['"]\s*\+)/g,
    message: 'SQL built from dynamic input — use parameterized queries',
  },
  {
    id: 'py-tls-verification-disabled',
    severity: 'high',
    pattern: /verify\s*=\s*False/g,
    message: 'TLS certificate verification disabled',
  },
  {
    id: 'py-weak-hash',
    severity: 'low',
    pattern: /hashlib\.(md5|sha1)\s*\(/g,
    message: 'Weak hash algorithm for security purposes — prefer sha256+',
  },
  {
    id: 'py-bare-except-pass',
    severity: 'low',
    pattern: /except\s*(Exception)?\s*:\s*\n\s*pass\b/g,
    message: 'Exception silently swallowed',
  },
  {
    id: 'py-debug-todo',
    severity: 'info',
    pattern: /#\s*(TODO|FIXME|HACK|XXX)\b/gi,
    message: 'Unresolved TODO/FIXME marker',
  },
];

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', 'env', '.tox',
  'site-packages', '.testreports', 'testframework', 'dist', 'build', '.mypy_cache', '.pytest_cache',
]);

function pythonBinary() {
  for (const bin of ['python3', 'python']) {
    const res = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10000 });
    if (res.status === 0) return bin;
  }
  return null;
}

function walkPy(root, out = [], dir = root) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDE_DIRS.has(entry.name) && !entry.name.startsWith('.')) walkPy(root, out, full);
    } else if (entry.isFile() && entry.name.endsWith('.py')) {
      out.push(full);
    }
  }
  return out;
}

function detect(root) {
  return walkPy(root).length > 0;
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === '\n') line++;
  return line;
}

/** Security + syntax analysis. Returns Sentinel finding records. */
function analyze(root, options = {}) {
  const python = pythonBinary();
  const files = walkPy(root);
  const findings = [];

  for (const file of files) {
    const rel = path.relative(root, file);
    const source = fs.readFileSync(file, 'utf8');
    for (const rule of PY_RULES) {
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      let m;
      while ((m = re.exec(source)) !== null) {
        if (rule.filter && !rule.filter(m)) continue;
        const line = lineOf(source, m.index);
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          file: rel,
          line,
          excerpt: (source.split('\n')[line - 1] || '').trim().slice(0, 160),
          message: rule.message,
        });
        if (re.lastIndex === m.index) re.lastIndex++;
      }
    }
    if (python) {
      const check = spawnSync(python, ['-m', 'py_compile', file], { encoding: 'utf8', timeout: 20000 });
      if (check.status !== 0) {
        findings.push({
          rule: 'py-syntax-error',
          severity: 'high',
          file: rel,
          line: 0,
          excerpt: '',
          message: `File does not parse: ${String(check.stderr || '').split('\n').slice(-3).join(' ').trim().slice(0, 200)}`,
        });
      }
    }
  }
  return { language: 'python', scannedFiles: files.length, findings, available: !!python };
}

/** Autonomous fuzzing via the stdlib harness. */
function fuzz(root, options = {}) {
  const python = pythonBinary();
  if (!python) return { reports: [], skipped: [{ file: '(python)', reason: 'python3 not found on PATH' }] };

  const candidates = walkPy(root)
    .map((f) => path.relative(root, f))
    .filter((rel) => {
      const base = path.basename(rel);
      return !base.startsWith('test') && !base.startsWith('conftest') && base !== 'setup.py' && base !== '__init__.py';
    });
  if (candidates.length === 0) return { reports: [], skipped: [] };

  const configFile = path.join(os.tmpdir(), `sentinel-pyfuzz-${process.pid}-${Math.floor(Math.random() * 1e6)}.json`);
  fs.writeFileSync(
    configFile,
    JSON.stringify({ root, files: candidates, seed: options.seed ?? 42, iterations: options.iterations ?? 120 })
  );
  try {
    const result = spawnSync(python, [path.join(__dirname, 'py', 'fuzz_harness.py'), configFile], {
      encoding: 'utf8',
      timeout: options.timeoutMs || 120000,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0) {
      return {
        reports: [],
        skipped: [{ file: '(python)', reason: `fuzz harness failed: ${String(result.stderr || '').split('\n').slice(0, 2).join(' ')}` }],
      };
    }
    return JSON.parse(result.stdout);
  } finally {
    try { fs.unlinkSync(configFile); } catch (e) { /* best effort */ }
  }
}

function hasPytest(python) {
  const res = spawnSync(python, ['-m', 'pytest', '--version'], { encoding: 'utf8', timeout: 20000 });
  return res.status === 0;
}

/** Run the project's Python tests; return Sentinel test records. */
function runTests(root, options = {}) {
  const python = pythonBinary();
  if (!python) return { tests: [], skippedReason: 'python3 not found on PATH' };

  const testFiles = walkPy(root).filter((f) => /(^|[\\/])test[^\\/]*\.py$|_test\.py$/.test(f));
  if (testFiles.length === 0) return { tests: [], skippedReason: null };

  // Dependency-free coverage path (opt-in): run the suite under sys.settrace.
  // Independent of pytest, so Python line coverage works with zero extra deps.
  if (options.coverage) {
    const productFiles = (options.productFiles || walkPy(root).map((f) => path.relative(root, f)))
      .filter((rel) => {
        const base = path.basename(rel);
        return !base.startsWith('test') && base !== 'conftest.py' && base !== 'setup.py' && base !== '__init__.py';
      });
    const cfgFile = path.join(os.tmpdir(), `sentinel-pycov-${process.pid}-${Math.floor(Math.random() * 1e6)}.json`);
    fs.writeFileSync(cfgFile, JSON.stringify({ root, start_dir: root, product_files: productFiles }));
    try {
      const res = spawnSync(python, [path.join(__dirname, 'py', 'coverage_runner.py'), cfgFile], {
        encoding: 'utf8',
        cwd: root,
        timeout: options.timeoutMs || 300000,
        maxBuffer: 32 * 1024 * 1024,
      });
      if (res.stdout) {
        const parsed = JSON.parse(res.stdout);
        return {
          tests: mapUnittestRecords(parsed.tests),
          runner: 'unittest+trace',
          coverage: parsed.coverage
            ? { linePct: parsed.coverage.overall.linePct, linesCovered: parsed.coverage.overall.linesCovered, linesMissed: parsed.coverage.overall.linesTotal - parsed.coverage.overall.linesCovered, files: parsed.coverage.files }
            : null,
        };
      }
      return { tests: [], skippedReason: `coverage runner failed: ${String(res.stderr || '').split('\n')[0]}` };
    } finally {
      try { fs.unlinkSync(cfgFile); } catch (e) { /* best effort */ }
    }
  }

  if (options.usePytest !== false && hasPytest(python)) {
    const outDir = path.join(root, '.testreports');
    fs.mkdirSync(outDir, { recursive: true });
    const xmlPath = path.join(outDir, 'python-junit.xml');
    spawnSync(python, ['-m', 'pytest', '-q', '--junitxml', xmlPath, root], {
      encoding: 'utf8',
      cwd: root,
      timeout: options.timeoutMs || 300000,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (fs.existsSync(xmlPath)) {
      return { tests: parseJUnitFile(xmlPath, { suitePrefix: 'python' }), runner: 'pytest' };
    }
    return { tests: [], skippedReason: 'pytest produced no JUnit XML' };
  }

  const result = spawnSync(python, [path.join(__dirname, 'py', 'unittest_runner.py'), root], {
    encoding: 'utf8',
    cwd: root,
    timeout: options.timeoutMs || 300000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0 && !result.stdout) {
    return { tests: [], skippedReason: `unittest runner failed: ${String(result.stderr || '').split('\n')[0]}` };
  }
  const parsed = JSON.parse(result.stdout);
  return { tests: mapUnittestRecords(parsed.tests), runner: 'unittest' };
}

function mapUnittestRecords(records) {
  return records.map((t) => ({
    suite: `python > ${t.classname || '(suite)'}`,
    name: t.name,
    fullName: `python > ${t.classname ? t.classname + ' > ' : ''}${t.name}`,
    status: t.status,
    error: t.status === 'failed' ? { name: 'TestFailure', message: t.message, stack: t.stack } : null,
    duration: t.time || 0,
    retries: 0,
    reqs: extractReqTags(t.name, t.classname),
    file: null,
  }));
}

module.exports = { detect, analyze, fuzz, runTests, PY_RULES, pythonBinary };
