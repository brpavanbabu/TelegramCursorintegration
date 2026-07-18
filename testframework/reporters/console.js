'use strict';

/** Sentinel Test Framework — human-readable console reporter. */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `[${code}m${s}[0m` : String(s));
const red = c('31');
const green = c('32');
const yellow = c('33');
const cyan = c('36');
const gray = c('90');
const bold = c('1');

const SEV_COLOR = { high: red, medium: yellow, low: cyan, info: gray };
const STATUS_ICON = { passed: green('✓'), failed: red('✗'), skipped: gray('○'), todo: gray('…') };

function header(title) {
  console.log('\n' + bold(`━━━ ${title} ` + '━'.repeat(Math.max(0, 60 - title.length))));
}

function reportTests(testReport, { verbose = false } = {}) {
  header('TEST RUN');
  let lastSuite = null;
  for (const t of testReport.tests) {
    if (!verbose && t.status === 'passed') {
      // still print grouped, but compact
    }
    if (t.suite !== lastSuite) {
      console.log(bold(`\n  ${t.suite || '(root)'}`));
      lastSuite = t.suite;
    }
    const time = t.duration >= 100 ? yellow(`(${t.duration}ms)`) : gray(`(${t.duration}ms)`);
    const retry = t.retries > 0 ? yellow(` [retried x${t.retries}]`) : '';
    console.log(`    ${STATUS_ICON[t.status] || '?'} ${t.name} ${time}${retry}`);
    if (t.status === 'failed' && t.error) {
      console.log(red(`        ${t.error.name || 'Error'}: ${t.error.message}`));
      if (t.error.expected !== undefined) console.log(gray(`        expected: ${t.error.expected}`));
      if (t.error.actual !== undefined) console.log(gray(`        actual:   ${t.error.actual}`));
      if (verbose && t.error.stack) console.log(gray(t.error.stack.split('\n').slice(1, 4).map((l) => '        ' + l.trim()).join('\n')));
    }
  }
  const s = testReport.summary;
  const line = `${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped${s.todo ? `, ${s.todo} todo` : ''} — ${s.total} total in ${s.duration}ms`;
  console.log('\n  ' + (s.failed > 0 ? red(bold(line)) : green(bold(line))));
}

function reportAnalysis(analysis) {
  header('STATIC & SECURITY ANALYSIS');
  console.log(gray(`  scanned ${analysis.scannedFiles} files, syntax-checked ${analysis.syntaxChecked} JS files`));
  if (analysis.findings.length === 0) {
    console.log(green('  ✓ no findings'));
    return;
  }
  for (const f of analysis.findings) {
    const paint = SEV_COLOR[f.severity] || gray;
    console.log(`  ${paint(`[${f.severity.toUpperCase()}]`)} ${bold(f.rule)} ${f.file}${f.line ? ':' + f.line : ''}`);
    console.log(`         ${f.message}`);
    if (f.excerpt) console.log(gray(`         > ${f.excerpt}`));
  }
  const counts = analysis.counts;
  console.log(
    `\n  findings: ${red(counts.high + ' high')}, ${yellow(counts.medium + ' medium')}, ${cyan(counts.low + ' low')}, ${gray(counts.info + ' info')}`
  );
}

function reportFuzz(fuzz) {
  header('AUTONOMOUS FUZZ / AUTO-GENERATED TESTS');
  console.log(gray(`  deterministic seed: ${fuzz.seed}`));
  for (const report of fuzz.reports) {
    console.log(bold(`\n  ${report.module}`) + gray(` — ${report.totalInvocations} auto-generated invocations`));
    for (const fn of report.functions) {
      const status = fn.crashSignatures.length === 0 ? green('robust') : red(`${fn.crashSignatures.length} crash signature(s)`);
      console.log(`    ${fn.crashSignatures.length === 0 ? green('✓') : red('✗')} ${fn.fn}(${fn.params.join(', ')}) — ${fn.invocations} calls — ${status}`);
      for (const crash of fn.crashSignatures.slice(0, 5)) {
        console.log(red(`        ${crash.signature}`) + gray(` ×${crash.count}  e.g. (${crash.exampleArgs})`));
      }
    }
    if (report.prototypePolluted) console.log(red('    ✗ PROTOTYPE POLLUTION detected during fuzzing'));
  }
  if (fuzz.skipped && fuzz.skipped.length) {
    console.log(gray('\n  skipped modules:'));
    for (const s of fuzz.skipped) console.log(gray(`    - ${s.file}: ${s.reason}`));
  }
}

function reportMatrix(matrix) {
  header('REQUIREMENTS TRACEABILITY MATRIX');
  const paint = { PASS: green, FAIL: red, UNCOVERED: yellow };
  for (const row of matrix.rows) {
    console.log(`  ${paint[row.status](bold(`[${row.status}]`))} ${bold(row.id)} (${row.priority}) — ${row.title}`);
    for (const check of row.checks) {
      console.log(`      ${check.passed ? green('✓') : red('✗')} auto-check ${check.desc}${check.passed ? '' : red(' — ' + check.detail)}`);
    }
    for (const t of row.linkedTests) {
      console.log(`      ${STATUS_ICON[t.status] || '?'} test ${gray(t.name)}`);
    }
  }
  const s = matrix.summary;
  console.log(
    `\n  requirements: ${green(s.pass + ' pass')}, ${red(s.fail + ' fail')}, ${yellow(s.uncovered + ' uncovered')} of ${s.total}`
  );
}

function reportCoverage(coverage) {
  header('COVERAGE (V8, in-process)');
  if (!coverage || !coverage.available) {
    console.log(yellow(`  coverage unavailable${coverage && coverage.error ? ': ' + coverage.error : ''}`));
    return;
  }
  const width = Math.max(...coverage.files.map((f) => f.file.length), 10);
  console.log(gray(`  ${'file'.padEnd(width)}  byte%   functions`));
  for (const f of coverage.files) {
    const paint = f.bytePct >= 80 ? green : f.bytePct >= 50 ? yellow : red;
    const fnCol = f.functionsTotal ? `${f.functionsCovered}/${f.functionsTotal}` : '-';
    const note = f.loaded ? '' : gray('  (never loaded by any test)');
    console.log(`  ${f.file.padEnd(width)}  ${paint(String(f.bytePct).padStart(5) + '%')}  ${fnCol.padStart(9)}${note}`);
    if (f.loaded && f.uncoveredLines.length > 0 && f.bytePct < 100) {
      console.log(gray(`  ${' '.repeat(width)}  uncovered lines ≈ ${f.uncoveredLines.slice(0, 12).join(', ')}${f.uncoveredLines.length > 12 ? '…' : ''}`));
    }
  }
  console.log(gray(`\n  overall: ${coverage.overall.bytePct}% bytes, ${coverage.overall.functionPct}% functions`));
}

function reportVerdict(verdict) {
  header('VERDICT');
  for (const line of verdict.reasons) {
    console.log(`  ${line.ok ? green('✓') : red('✗')} ${line.text}`);
  }
  console.log('\n  ' + (verdict.pass ? green(bold('■ OVERALL: PASS')) : red(bold('■ OVERALL: FAIL'))) + '\n');
}

module.exports = { reportTests, reportAnalysis, reportFuzz, reportMatrix, reportCoverage, reportVerdict };
