'use strict';

/**
 * Sentinel Test Framework — polyglot adapter registry
 *
 * Detects which language ecosystems a project contains and fans the
 * pipeline out to each adapter. All adapters speak Sentinel's native data
 * shapes (findings, test records, fuzz reports), so results from every
 * language merge into ONE report, ONE traceability matrix, ONE verdict.
 */

const python = require('./python');
const jvm = require('./jvm');

const ADAPTERS = { python, jvm };

/**
 * @returns {string[]} adapter names active for this project
 */
function detectLanguages(root, config = {}) {
  const langCfg = config.languages || {};
  const active = [];
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    const setting = langCfg[name];
    if (setting === false) continue;
    if (setting === true || adapter.detect(root)) active.push(name);
  }
  return active;
}

/** Merge adapter findings into a Sentinel analysis result (mutates). */
function mergeAnalysis(analysis, adapterResults) {
  for (const res of adapterResults) {
    analysis.scannedFiles += res.scannedFiles || 0;
    analysis.findings.push(...res.findings);
  }
  analysis.findings.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2, info: 3 };
    return (order[a.severity] - order[b.severity]) || a.file.localeCompare(b.file) || a.line - b.line;
  });
  const counts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of analysis.findings) counts[f.severity]++;
  analysis.counts = counts;
  return analysis;
}

/** Merge external test records into a Sentinel test report (mutates). */
function mergeTests(testReport, externalTests) {
  if (!externalTests || externalTests.length === 0) return testReport;
  testReport.tests.push(...externalTests);
  const s = testReport.summary;
  for (const t of externalTests) {
    s.total++;
    if (t.status === 'passed') s.passed++;
    else if (t.status === 'failed') s.failed++;
    else if (t.status === 'todo') s.todo++;
    else s.skipped++;
    s.duration += t.duration || 0;
  }
  return testReport;
}

/** Merge adapter fuzz output into a Sentinel fuzz result (mutates). */
function mergeFuzz(fuzz, adapterFuzz) {
  if (!adapterFuzz) return fuzz;
  fuzz.reports.push(...(adapterFuzz.reports || []));
  fuzz.skipped.push(...(adapterFuzz.skipped || []));
  return fuzz;
}

module.exports = { ADAPTERS, detectLanguages, mergeAnalysis, mergeTests, mergeFuzz, python, jvm };
