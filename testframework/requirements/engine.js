'use strict';

/**
 * Sentinel Test Framework — Requirements Engine
 *
 * "Test by requirement": requirements are written in a machine-readable file
 * and the engine turns them into executable verification automatically —
 * no hand-written test needed for anything expressible in the check DSL.
 * Hand-written tests link back to requirements via `reqs: ['SEC-001']`
 * metadata, producing a full traceability matrix:
 *
 *     requirement -> automated checks + linked tests -> PASS / FAIL / UNCOVERED
 *
 * Check DSL (each check runs with no human involvement):
 *   file_exists         { path }
 *   file_missing        { path }
 *   source_contains     { file, pattern, flags? }
 *   source_not_contains { file, pattern, flags? }
 *   json_path           { file, path: "a.b.c", equals? , matches? }
 *   package_script      { name, contains? }
 *   module_exports      { file, names: [..] }        (sandbox-loaded)
 *   constant_equals     { file, export, equals }     (sandbox-loaded)
 *   function_returns    { file, export, args, equals } (sandbox-loaded)
 *   syntax_ok           { files: [..] }
 *   no_findings         { rule?, severity?, file? }  (uses analyzer output)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadSandboxed } = require('../core/loader');
const { deepEqual, fmt } = require('../core/assert');

function loadRequirements(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const doc = JSON.parse(raw);
  if (!Array.isArray(doc.requirements)) {
    throw new Error(`Requirements file ${filePath} must contain a "requirements" array`);
  }
  return doc;
}

function getJsonPath(obj, dotted) {
  let cur = obj;
  for (const part of String(dotted).split('.')) {
    if (cur === null || cur === undefined || !(part in Object(cur))) return { found: false };
    cur = cur[part];
  }
  return { found: true, value: cur };
}

function runCheck(check, ctx) {
  const root = ctx.root;
  const describeCheck = (extra) => `${check.type}(${extra})`;

  try {
    switch (check.type) {
      case 'file_exists': {
        const target = path.resolve(root, check.path);
        const ok = fs.existsSync(target);
        return { desc: describeCheck(check.path), passed: ok, detail: ok ? 'file present' : `missing: ${check.path}` };
      }
      case 'file_missing': {
        const target = path.resolve(root, check.path);
        const ok = !fs.existsSync(target);
        return { desc: describeCheck(check.path), passed: ok, detail: ok ? 'correctly absent' : `${check.path} must not be committed` };
      }
      case 'source_contains':
      case 'source_not_contains': {
        const target = path.resolve(root, check.file);
        if (!fs.existsSync(target)) {
          return { desc: describeCheck(`${check.file} ~ /${check.pattern}/`), passed: false, detail: `file missing: ${check.file}` };
        }
        const source = fs.readFileSync(target, 'utf8');
        const re = new RegExp(check.pattern, check.flags || '');
        const found = re.test(source);
        const wantFound = check.type === 'source_contains';
        return {
          desc: describeCheck(`${check.file} ~ /${check.pattern}/`),
          passed: found === wantFound,
          detail: found
            ? wantFound ? 'pattern found' : `forbidden pattern present in ${check.file}`
            : wantFound ? `pattern not found in ${check.file}` : 'pattern absent',
        };
      }
      case 'json_path': {
        const target = path.resolve(root, check.file);
        const doc = JSON.parse(fs.readFileSync(target, 'utf8'));
        const res = getJsonPath(doc, check.path);
        if (!res.found) {
          return { desc: describeCheck(`${check.file}#${check.path}`), passed: false, detail: `path ${check.path} not found` };
        }
        if ('equals' in check) {
          const ok = deepEqual(res.value, check.equals);
          return { desc: describeCheck(`${check.file}#${check.path}`), passed: ok, detail: ok ? `= ${fmt(check.equals)}` : `expected ${fmt(check.equals)}, got ${fmt(res.value)}` };
        }
        if ('matches' in check) {
          const ok = new RegExp(check.matches).test(String(res.value));
          return { desc: describeCheck(`${check.file}#${check.path}`), passed: ok, detail: ok ? `matches /${check.matches}/` : `${fmt(res.value)} does not match /${check.matches}/` };
        }
        return { desc: describeCheck(`${check.file}#${check.path}`), passed: true, detail: 'path exists' };
      }
      case 'package_script': {
        const pkg = JSON.parse(fs.readFileSync(path.resolve(root, 'package.json'), 'utf8'));
        const script = pkg.scripts && pkg.scripts[check.name];
        let ok = typeof script === 'string' && script.length > 0;
        if (ok && check.contains) ok = script.includes(check.contains);
        return { desc: describeCheck(check.name), passed: ok, detail: ok ? `"${check.name}": "${script}"` : `npm script "${check.name}" ${script ? `does not contain "${check.contains}"` : 'missing'}` };
      }
      case 'module_exports': {
        const { exports: mod } = loadSandboxed(path.resolve(root, check.file), ctx.sandboxOpts || {});
        const missing = (check.names || []).filter((n) => !(n in mod));
        return { desc: describeCheck(`${check.file} exports ${check.names.join(', ')}`), passed: missing.length === 0, detail: missing.length ? `missing exports: ${missing.join(', ')}` : 'all exports present' };
      }
      case 'constant_equals': {
        const { exports: mod } = loadSandboxed(path.resolve(root, check.file), ctx.sandboxOpts || {});
        const ok = deepEqual(mod[check.export], check.equals);
        return { desc: describeCheck(`${check.file}#${check.export}`), passed: ok, detail: ok ? `${check.export} = ${fmt(check.equals)}` : `expected ${fmt(check.equals)}, got ${fmt(mod[check.export])}` };
      }
      case 'function_returns': {
        const { exports: mod } = loadSandboxed(path.resolve(root, check.file), ctx.sandboxOpts || {});
        const fnc = mod[check.export];
        if (typeof fnc !== 'function') {
          return { desc: describeCheck(`${check.file}#${check.export}()`), passed: false, detail: `${check.export} is not an exported function` };
        }
        const value = fnc(...(check.args || []));
        const ok = deepEqual(value, check.equals);
        return { desc: describeCheck(`${check.file}#${check.export}(${(check.args || []).map(fmt).join(', ')})`), passed: ok, detail: ok ? `returned ${fmt(check.equals)}` : `expected ${fmt(check.equals)}, got ${fmt(value)}` };
      }
      case 'syntax_ok': {
        const failures = [];
        for (const rel of check.files || []) {
          const target = path.resolve(root, rel);
          const result = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8', timeout: 15000 });
          if (result.status !== 0) failures.push(rel);
        }
        return { desc: describeCheck((check.files || []).join(', ')), passed: failures.length === 0, detail: failures.length ? `syntax errors in: ${failures.join(', ')}` : 'all files parse' };
      }
      case 'command_succeeds': {
        const result = spawnSync(check.command, {
          shell: true,
          cwd: check.cwd ? path.resolve(root, check.cwd) : root,
          encoding: 'utf8',
          timeout: check.timeoutMs || 120000,
        });
        const ok = result.status === 0;
        return {
          desc: describeCheck(check.command),
          passed: ok,
          detail: ok
            ? 'exit code 0'
            : `exit ${result.status}: ${String(result.stderr || result.stdout || '').split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 200)}`,
        };
      }
      case 'no_findings': {
        const findings = (ctx.analysis ? ctx.analysis.findings : []).filter((f) => {
          if (check.rule && f.rule !== check.rule) return false;
          if (check.severity && f.severity !== check.severity) return false;
          if (check.file && f.file !== check.file) return false;
          return true;
        });
        return {
          desc: describeCheck([check.rule, check.severity, check.file].filter(Boolean).join(', ') || 'any'),
          passed: findings.length === 0,
          detail: findings.length ? `${findings.length} finding(s), e.g. ${findings[0].file}:${findings[0].line} ${findings[0].message}` : 'no matching findings',
        };
      }
      default:
        return { desc: describeCheck('?'), passed: false, detail: `unknown check type "${check.type}"` };
    }
  } catch (err) {
    return { desc: describeCheck('error'), passed: false, detail: `check crashed: ${err.message}` };
  }
}

/**
 * Evaluate every requirement: run its automated checks, join linked test
 * results, and compute a verdict.
 */
function evaluate(requirementsDoc, testResults = [], ctx = {}) {
  const rows = [];
  for (const req of requirementsDoc.requirements) {
    const checks = (req.verify || []).map((check) => runCheck(check, ctx));
    const linkedTests = testResults
      .filter((t) => Array.isArray(t.reqs) && t.reqs.includes(req.id))
      .map((t) => ({ name: t.fullName, status: t.status }));

    const consideredTests = linkedTests.filter((t) => t.status === 'passed' || t.status === 'failed');
    const anyEvidence = checks.length > 0 || consideredTests.length > 0;
    const anyFailure = checks.some((c) => !c.passed) || consideredTests.some((t) => t.status === 'failed');

    rows.push({
      id: req.id,
      title: req.title,
      priority: req.priority || 'medium',
      checks,
      linkedTests,
      status: !anyEvidence ? 'UNCOVERED' : anyFailure ? 'FAIL' : 'PASS',
    });
  }

  const summary = {
    total: rows.length,
    pass: rows.filter((r) => r.status === 'PASS').length,
    fail: rows.filter((r) => r.status === 'FAIL').length,
    uncovered: rows.filter((r) => r.status === 'UNCOVERED').length,
  };

  return { project: requirementsDoc.project || null, rows, summary };
}

module.exports = { loadRequirements, evaluate, runCheck };
