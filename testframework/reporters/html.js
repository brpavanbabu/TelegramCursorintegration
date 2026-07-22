'use strict';

/** Sentinel Test Framework — self-contained HTML report (no external assets). */

const fs = require('fs');
const path = require('path');

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function badge(text, kind) {
  return `<span class="badge ${kind}">${esc(text)}</span>`;
}

function write(report, outFile) {
  const t = report.tests ? report.tests.summary : null;
  const m = report.matrix ? report.matrix.summary : null;
  const a = report.analysis ? report.analysis.counts : null;

  const testRows = (report.tests ? report.tests.tests : [])
    .map(
      (x) => `<tr class="st-${x.status}">
        <td>${badge(x.status, x.status)}</td>
        <td>${esc(x.suite || '(root)')}</td>
        <td>${esc(x.name)}${x.error ? `<div class="err">${esc(x.error.message)}</div>` : ''}</td>
        <td class="num">${x.duration}ms</td>
        <td>${(x.reqs || []).map((r) => badge(r, 'req')).join(' ')}</td>
      </tr>`
    )
    .join('\n');

  const findingRows = (report.analysis ? report.analysis.findings : [])
    .map(
      (f) => `<tr>
        <td>${badge(f.severity, 'sev-' + f.severity)}</td>
        <td>${esc(f.rule)}</td>
        <td>${esc(f.file)}${f.line ? ':' + f.line : ''}</td>
        <td>${esc(f.message)}${f.excerpt ? `<div class="excerpt">${esc(f.excerpt)}</div>` : ''}</td>
      </tr>`
    )
    .join('\n');

  const matrixRows = (report.matrix ? report.matrix.rows : [])
    .map(
      (r) => `<tr>
        <td>${badge(r.status, r.status.toLowerCase())}</td>
        <td><strong>${esc(r.id)}</strong></td>
        <td>${esc(r.priority)}</td>
        <td>${esc(r.title)}
          <ul class="detail">
            ${r.checks.map((ch) => `<li>${ch.passed ? '✓' : '✗'} auto-check ${esc(ch.desc)} — ${esc(ch.detail)}</li>`).join('')}
            ${r.linkedTests.map((lt) => `<li>${lt.status === 'passed' ? '✓' : lt.status === 'failed' ? '✗' : '○'} test ${esc(lt.name)}</li>`).join('')}
          </ul>
        </td>
      </tr>`
    )
    .join('\n');

  const fuzzRows = (report.fuzz ? report.fuzz.reports : [])
    .flatMap((rep) =>
      rep.functions.map(
        (fn) => `<tr>
        <td>${esc(rep.module)}</td>
        <td><code>${esc(fn.fn)}(${esc(fn.params.join(', '))})</code></td>
        <td class="num">${fn.invocations}</td>
        <td>${fn.crashSignatures.length === 0 ? badge('robust', 'passed') : badge(fn.crashSignatures.length + ' crash sig(s)', 'failed')}
          ${fn.crashSignatures
            .slice(0, 5)
            .map((cs) => `<div class="err">${esc(cs.signature)} ×${cs.count} — e.g. (${esc(cs.exampleArgs)})</div>`)
            .join('')}
        </td>
      </tr>`
      )
    )
    .join('\n');

  const coverageRows = (report.coverage && report.coverage.files ? report.coverage.files : [])
    .map(
      (f) => `<tr>
        <td>${esc(f.file)}</td>
        <td class="num">${f.bytePct}%</td>
        <td class="num">${f.functionsCovered}/${f.functionsTotal}</td>
        <td>${f.loaded ? '' : badge('never loaded', 'uncovered')}</td>
      </tr>`
    )
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sentinel Test Report — ${esc(report.project || '')}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 2rem auto; max-width: 1100px; padding: 0 1rem; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2.2rem; border-bottom: 2px solid #8884; padding-bottom: .3rem; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #8883; vertical-align: top; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .badge { display: inline-block; padding: .1rem .45rem; border-radius: .6rem; font-size: .72rem; font-weight: 600; }
  .passed, .pass { background: #16a34a22; color: #16a34a; }
  .failed, .fail { background: #dc262622; color: #dc2626; }
  .skipped, .todo, .uncovered { background: #ca8a0422; color: #ca8a04; }
  .req { background: #2563eb22; color: #2563eb; }
  .sev-high { background: #dc262622; color: #dc2626; }
  .sev-medium { background: #ca8a0422; color: #ca8a04; }
  .sev-low { background: #0891b222; color: #0891b2; }
  .sev-info { background: #6b728022; color: #6b7280; }
  .err { color: #dc2626; font-family: ui-monospace, monospace; font-size: .78rem; margin-top: .2rem; white-space: pre-wrap; }
  .excerpt { color: #6b7280; font-family: ui-monospace, monospace; font-size: .75rem; }
  .cards { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1rem 0; }
  .card { border: 1px solid #8884; border-radius: .6rem; padding: .8rem 1.2rem; min-width: 130px; }
  .card b { display: block; font-size: 1.5rem; }
  ul.detail { margin: .3rem 0 0; padding-left: 1.1rem; color: #6b7280; }
  .verdict { font-size: 1.2rem; font-weight: 700; padding: .6rem 1rem; border-radius: .6rem; display: inline-block; margin-top: .6rem; }
</style>
</head>
<body>
<h1>🛡️ Sentinel Test Report${report.project ? ' — ' + esc(report.project) : ''}</h1>
<div>${esc(report.generatedAt || '')}</div>
${report.verdict ? `<div class="verdict ${report.verdict.pass ? 'passed' : 'failed'}">${report.verdict.pass ? 'OVERALL: PASS' : 'OVERALL: FAIL'}</div>` : ''}

<div class="cards">
  ${t ? `<div class="card">Tests<b>${t.passed}/${t.total}</b>passed</div>` : ''}
  ${m ? `<div class="card">Requirements<b>${m.pass}/${m.total}</b>verified</div>` : ''}
  ${a ? `<div class="card">Findings<b>${a.high + a.medium}</b>high+medium</div>` : ''}
  ${report.coverage && report.coverage.overall ? `<div class="card">Coverage<b>${report.coverage.overall.bytePct}%</b>bytes</div>` : ''}
  ${report.fuzz ? `<div class="card">Fuzz calls<b>${report.fuzz.reports.reduce((n, r) => n + r.totalInvocations, 0)}</b>auto-generated</div>` : ''}
</div>

${t ? `<h2>Test results</h2><table><tr><th>Status</th><th>Suite</th><th>Test</th><th>Time</th><th>Requirements</th></tr>${testRows}</table>` : ''}
${report.matrix ? `<h2>Requirements traceability</h2><table><tr><th>Status</th><th>ID</th><th>Priority</th><th>Requirement</th></tr>${matrixRows}</table>` : ''}
${report.analysis ? `<h2>Static &amp; security analysis</h2><table><tr><th>Severity</th><th>Rule</th><th>Location</th><th>Message</th></tr>${findingRows || '<tr><td colspan="4">No findings 🎉</td></tr>'}</table>` : ''}
${report.fuzz ? `<h2>Autonomous fuzzing</h2><table><tr><th>Module</th><th>Function</th><th>Calls</th><th>Result</th></tr>${fuzzRows}</table>` : ''}
${report.coverage ? `<h2>Coverage</h2><table><tr><th>File</th><th>Bytes</th><th>Functions</th><th></th></tr>${coverageRows}</table>` : ''}

<p style="color:#6b7280;margin-top:2rem">Generated by Sentinel Test Framework — zero-dependency autonomous testing.</p>
</body>
</html>`;

  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, html, 'utf8');
  return outFile;
}

module.exports = { write };
