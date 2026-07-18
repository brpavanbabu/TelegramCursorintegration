'use strict';

/** Sentinel Test Framework — JUnit XML reporter (CI-compatible). */

const fs = require('fs');
const path = require('path');

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function write(testReport, outFile) {
  const bySuite = new Map();
  for (const t of testReport.tests) {
    const key = t.suite || '(root)';
    if (!bySuite.has(key)) bySuite.set(key, []);
    bySuite.get(key).push(t);
  }

  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const total = testReport.summary;
  lines.push(
    `<testsuites name="sentinel" tests="${total.total}" failures="${total.failed}" skipped="${total.skipped + (total.todo || 0)}" time="${(total.duration / 1000).toFixed(3)}">`
  );
  for (const [suiteName, tests] of bySuite) {
    const failures = tests.filter((t) => t.status === 'failed').length;
    const skipped = tests.filter((t) => t.status === 'skipped' || t.status === 'todo').length;
    const time = tests.reduce((n, t) => n + t.duration, 0) / 1000;
    lines.push(`  <testsuite name="${esc(suiteName)}" tests="${tests.length}" failures="${failures}" skipped="${skipped}" time="${time.toFixed(3)}">`);
    for (const t of tests) {
      lines.push(`    <testcase classname="${esc(suiteName)}" name="${esc(t.name)}" time="${(t.duration / 1000).toFixed(3)}">`);
      if (t.status === 'failed' && t.error) {
        lines.push(`      <failure message="${esc(t.error.message)}" type="${esc(t.error.name || 'Error')}">${esc(t.error.stack || t.error.message)}</failure>`);
      } else if (t.status === 'skipped' || t.status === 'todo') {
        lines.push('      <skipped/>');
      }
      lines.push('    </testcase>');
    }
    lines.push('  </testsuite>');
  }
  lines.push('</testsuites>');

  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
  return outFile;
}

module.exports = { write };
