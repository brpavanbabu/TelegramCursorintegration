'use strict';

/**
 * Self-tests for the polyglot adapter layer: JUnit XML ingestion,
 * requirement-tag extraction, Python analysis/fuzzing/test-running and
 * JVM source analysis. Python cases run only when python3 is on PATH
 * (it is on every CI image this repo targets).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, expect, beforeAll, afterAll } = require('../testframework');
const { parseJUnitXml, extractReqTags } = require('../testframework/adapters/junit-xml');
const pythonAdapter = require('../testframework/adapters/python');
const jvmAdapter = require('../testframework/adapters/jvm');
const contract = require('../testframework/adapters/contract');

const HAS_PYTHON = !!pythonAdapter.pythonBinary();

describe('polyglot: JUnit XML ingestion', () => {
  it('parses passed / failed / skipped testcases with timings', () => {
    const xml = `<?xml version="1.0"?>
<testsuite name="com.example.AuthTest" tests="3">
  <testcase classname="com.example.AuthTest" name="locks after 3 attempts [SEC-002]" time="0.042"/>
  <testcase classname="com.example.AuthTest" name="rejects &lt;bad&gt; input" time="0.010">
    <failure message="expected &quot;x&quot; but was &quot;y&quot;" type="AssertionError">stack line 1
stack line 2</failure>
  </testcase>
  <testcase classname="com.example.AuthTest" name="future work" time="0">
    <skipped/>
  </testcase>
</testsuite>`;
    const tests = parseJUnitXml(xml, { suitePrefix: 'jvm' });
    expect(tests).toHaveLength(3);

    expect(tests[0].status).toBe('passed');
    expect(tests[0].duration).toBe(42);
    expect(tests[0].reqs).toContain('SEC-002');
    expect(tests[0].fullName).toBe('jvm > com.example.AuthTest > locks after 3 attempts [SEC-002]');

    expect(tests[1].status).toBe('failed');
    expect(tests[1].name).toBe('rejects <bad> input');
    expect(tests[1].error.message).toContain('expected "x" but was "y"');

    expect(tests[2].status).toBe('skipped');
  });

  it('extracts requirement tags from bracket and snake_case conventions', () => {
    expect(extractReqTags('locks out [SEC-002] properly')).toContain('SEC-002');
    expect(extractReqTags('test_lockout_after_attempts_SEC002')).toContain('SEC-002');
    expect(extractReqTags('nothing here')).toHaveLength(0);
  });

  it('preserves CDATA-wrapped failure stack traces (real Gradle/Surefire output)', () => {
    const xml = `<testsuite name="T">
  <testcase classname="T" name="boom" time="0.01">
    <failure message="expected 1" type="AssertionError"><![CDATA[
java.lang.AssertionError: expected 1 but was 2
  at T.boom(T.java:14)
  if (a < b && c > d) { throw new AssertionError(); }
]]></failure>
  </testcase>
</testsuite>`;
    const [t] = parseJUnitXml(xml);
    expect(t.status).toBe('failed');
    // The raw < > & inside CDATA must survive un-mangled.
    expect(t.error.stack).toContain('a < b && c > d');
    expect(t.error.stack).toContain('at T.boom(T.java:14)');
  });
});

describe('polyglot: adapter contract enforcement', () => {
  it('accepts well-formed adapter results', () => {
    expect(() =>
      contract.validateAnalysis({ language: 'x', scannedFiles: 1, findings: [
        { rule: 'r', severity: 'high', file: 'a.x', line: 1, message: 'bad' },
      ] }, 'x')
    ).not.toThrow();
    expect(() =>
      contract.validateTestRun({ tests: [
        { name: 'n', fullName: 'f > n', status: 'passed', duration: 1, reqs: [], error: null },
      ] }, 'x')
    ).not.toThrow();
  });

  it('rejects malformed results with a precise message (fail loud, not silent)', () => {
    expect(() => contract.validateAnalysis({ language: 'x', scannedFiles: 1, findings: [
      { rule: 'r', severity: 'critical', file: 'a', line: 1, message: 'm' }, // bad severity
    ] }, 'x')).toThrow('severity');
    expect(() => contract.validateTestRun({ tests: [
      { name: 'n', fullName: 'f', status: 'green', duration: 1, reqs: [], error: null }, // bad status
    ] }, 'x')).toThrow('status');
    expect(() => contract.validateFuzz({ reports: 'nope', skipped: [] }, 'x')).toThrow('reports');
  });

  it('rejects an adapter missing detect()', () => {
    expect(() => contract.validateAdapterShape({ analyze: () => {} }, 'broken')).toThrow('detect');
  });
});

describe('polyglot: JVM source analysis', () => {
  let dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-jvm-'));
    fs.writeFileSync(
      path.join(dir, 'Login.java'),
      [
        'public class Login {',
        '  private static final String PASSWORD = "hunter2secret";',
        '  String query(String user) { return "SELECT * FROM users WHERE name=\'" + user; }',
        '  void run(String cmd) throws Exception { Runtime.getRuntime().exec(cmd); }',
        '}',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, 'Hash.kt'),
      'val digest = java.security.MessageDigest.getInstance("MD5")\n'
    );
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('detects JVM projects and flags credential/injection/weak-hash issues', () => {
    expect(jvmAdapter.detect(dir)).toBe(true);
    const { findings } = jvmAdapter.analyze(dir);
    const rules = findings.map((f) => f.rule);
    expect(rules).toContain('jvm-hardcoded-credential');
    expect(rules).toContain('jvm-sql-injection-risk');
    expect(rules).toContain('jvm-command-injection-risk');
    expect(rules).toContain('jvm-weak-hash');
  });

  it('reports no build tool gracefully when only sources exist', () => {
    const res = jvmAdapter.runTests(dir);
    expect(res.tests).toHaveLength(0);
    expect(res.skippedReason).toMatch(/build tool/);
  });
});

describe('polyglot: Python adapter', () => {
  let dir;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-py-'));
    fs.writeFileSync(
      path.join(dir, 'calc.py'),
      [
        '"""Tiny calculator module."""',
        '',
        'API_TOKEN = "sk-live-verysecret-1234"',
        '',
        '',
        'def divide(a, b):',
        '    return a / b',
        '',
        '',
        'def greet(name):',
        '    return eval("\'hello \' + name")  # noqa: S307',
        '',
        '',
        'def add(a, b):',
        '    return (a or 0) + (b or 0) if not isinstance(a, str) else str(a) + str(b)',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, 'test_calc.py'),
      [
        'import unittest',
        '',
        'from calc import divide',
        '',
        '',
        'class CalcTests(unittest.TestCase):',
        '    def test_divide_normal_CALC001(self):',
        '        self.assertEqual(divide(10, 2), 5)',
        '',
        '    def test_divide_rejects_zero_CALC002(self):',
        '        with self.assertRaises(ZeroDivisionError):',
        '            divide(1, 0)',
      ].join('\n')
    );
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('detects Python projects', () => {
    if (!HAS_PYTHON) return;
    expect(pythonAdapter.detect(dir)).toBe(true);
  });

  it('flags eval and hardcoded credentials in Python source', () => {
    if (!HAS_PYTHON) return;
    const { findings } = pythonAdapter.analyze(dir);
    const rules = findings.map((f) => f.rule);
    expect(rules).toContain('py-eval-exec');
    expect(rules).toContain('py-hardcoded-credential');
  }, { timeout: 30000 });

  it('autonomously fuzzes Python functions and finds the division crash', () => {
    if (!HAS_PYTHON) return;
    const fuzz = pythonAdapter.fuzz(dir, { seed: 42, iterations: 15 });
    expect(fuzz.reports).toHaveLength(1);
    const divideReport = fuzz.reports[0].functions.find((f) => f.fn === 'divide');
    expect(divideReport).toBeDefined();
    const signatures = divideReport.crashSignatures.map((c) => c.signature).join('\n');
    expect(signatures).toContain('ZeroDivisionError');
    // deterministic: same seed, same totals
    const again = pythonAdapter.fuzz(dir, { seed: 42, iterations: 15 });
    expect(again.reports[0].totalInvocations).toBe(fuzz.reports[0].totalInvocations);
  }, { timeout: 60000 });

  it('runs Python tests and links [REQ] tags into Sentinel records', () => {
    if (!HAS_PYTHON) return;
    const res = pythonAdapter.runTests(dir, { timeoutMs: 120000 });
    expect(res.tests.length).toBeGreaterThanOrEqual(2);
    const normal = res.tests.find((t) => t.name.includes('test_divide_normal'));
    expect(normal.status).toBe('passed');
    expect(normal.reqs).toContain('CALC-001');
  }, { timeout: 120000 });

  it('collects dependency-free Python line coverage via sys.settrace', () => {
    if (!HAS_PYTHON) return;
    const res = pythonAdapter.runTests(dir, { coverage: true, productFiles: ['calc.py'], timeoutMs: 120000 });
    expect(res.runner).toBe('unittest+trace');
    expect(res.coverage).toBeDefined();
    expect(res.coverage.linePct).toBeGreaterThan(0);
    expect(res.coverage.linePct).toBeLessThanOrEqual(100);
    // divide() is exercised by the tests; its body line must be covered,
    // and greet()/add() (untested) must show as missed lines.
    expect(res.coverage.linesCovered).toBeGreaterThan(0);
    expect(res.coverage.linesMissed).toBeGreaterThan(0);
  }, { timeout: 120000 });
});
