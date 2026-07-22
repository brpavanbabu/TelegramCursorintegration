'use strict';

/**
 * Sentinel Test Framework — Language Adapter Contract
 *
 * The whole "add any language" thesis depends on this seam, so the shapes are
 * written down here AND enforced at runtime. A malformed adapter result fails
 * loudly at the merge boundary instead of silently mis-rendering in a report.
 *
 * An adapter is an object exposing:
 *
 *   detect(root: string): boolean
 *       - cheap check for whether this language is present in the project.
 *
 *   analyze(root: string, options?): AnalysisResult        (optional)
 *       AnalysisResult = {
 *         language: string,
 *         scannedFiles: number,
 *         findings: Finding[],
 *       }
 *
 *   fuzz(root: string, options?): FuzzResult                (optional)
 *       FuzzResult = { reports: FuzzModuleReport[], skipped: Skip[], seed?: number }
 *
 *   runTests(root: string, options?): TestRunResult         (optional)
 *       TestRunResult = {
 *         tests: TestRecord[],
 *         runner?: string,
 *         skippedReason?: string|null,
 *         coverage?: { linePct, linesCovered, linesMissed } | null,
 *       }
 *
 * Shared record shapes:
 *
 *   Finding   = { rule, severity: 'high'|'medium'|'low'|'info', file, line, excerpt?, message }
 *   TestRecord= { suite, name, fullName, status: 'passed'|'failed'|'skipped'|'todo',
 *                 error: {name,message,stack?}|null, duration: number, reqs: string[], file?: string|null }
 *   FuzzModuleReport = { module, functions: FuzzFnReport[], totalInvocations, totalCrashSignatures, ... }
 *   FuzzFnReport = { fn, params: string[], invocations, crashSignatures: [{signature,count,exampleArgs}] }
 *   Skip      = { file, reason }
 */

const SEVERITIES = new Set(['high', 'medium', 'low', 'info']);
const STATUSES = new Set(['passed', 'failed', 'skipped', 'todo']);

class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdapterContractError';
  }
}

function req(cond, msg, ctx) {
  if (!cond) throw new ContractError(`${ctx}: ${msg}`);
}

function validateFinding(f, ctx) {
  req(f && typeof f === 'object', 'finding must be an object', ctx);
  req(typeof f.rule === 'string' && f.rule, 'finding.rule must be a non-empty string', ctx);
  req(SEVERITIES.has(f.severity), `finding.severity must be one of ${[...SEVERITIES].join('/')}, got ${JSON.stringify(f.severity)}`, ctx);
  req(typeof f.file === 'string', 'finding.file must be a string', ctx);
  req(typeof f.line === 'number', 'finding.line must be a number', ctx);
  req(typeof f.message === 'string' && f.message, 'finding.message must be a non-empty string', ctx);
  return f;
}

function validateAnalysis(result, adapterName) {
  const ctx = `adapter "${adapterName}" analyze()`;
  req(result && typeof result === 'object', 'must return an object', ctx);
  req(typeof result.language === 'string', 'result.language must be a string', ctx);
  req(typeof result.scannedFiles === 'number', 'result.scannedFiles must be a number', ctx);
  req(Array.isArray(result.findings), 'result.findings must be an array', ctx);
  result.findings.forEach((f, i) => validateFinding(f, `${ctx} findings[${i}]`));
  return result;
}

function validateTestRecord(t, ctx) {
  req(t && typeof t === 'object', 'test record must be an object', ctx);
  req(typeof t.name === 'string' && t.name, 'record.name must be a non-empty string', ctx);
  req(typeof t.fullName === 'string' && t.fullName, 'record.fullName must be a non-empty string', ctx);
  req(STATUSES.has(t.status), `record.status must be one of ${[...STATUSES].join('/')}, got ${JSON.stringify(t.status)}`, ctx);
  req(typeof t.duration === 'number', 'record.duration must be a number', ctx);
  req(Array.isArray(t.reqs), 'record.reqs must be an array', ctx);
  req(t.error === null || (t.error && typeof t.error.message === 'string'), 'record.error must be null or {message}', ctx);
  return t;
}

function validateTestRun(result, adapterName) {
  const ctx = `adapter "${adapterName}" runTests()`;
  req(result && typeof result === 'object', 'must return an object', ctx);
  req(Array.isArray(result.tests), 'result.tests must be an array', ctx);
  result.tests.forEach((t, i) => validateTestRecord(t, `${ctx} tests[${i}]`));
  return result;
}

function validateFuzz(result, adapterName) {
  const ctx = `adapter "${adapterName}" fuzz()`;
  req(result && typeof result === 'object', 'must return an object', ctx);
  req(Array.isArray(result.reports), 'result.reports must be an array', ctx);
  req(Array.isArray(result.skipped), 'result.skipped must be an array', ctx);
  for (let i = 0; i < result.reports.length; i++) {
    const r = result.reports[i];
    req(typeof r.module === 'string', `reports[${i}].module must be a string`, ctx);
    req(Array.isArray(r.functions), `reports[${i}].functions must be an array`, ctx);
  }
  return result;
}

/** Assert an adapter exposes the required surface before it is registered. */
function validateAdapterShape(adapter, name) {
  const ctx = `adapter "${name}"`;
  req(adapter && typeof adapter === 'object', 'must be an object', ctx);
  req(typeof adapter.detect === 'function', 'must expose detect(root)', ctx);
  for (const optional of ['analyze', 'fuzz', 'runTests']) {
    if (adapter[optional] !== undefined) {
      req(typeof adapter[optional] === 'function', `${optional} must be a function if present`, ctx);
    }
  }
  return adapter;
}

module.exports = {
  ContractError,
  validateAdapterShape,
  validateAnalysis,
  validateTestRun,
  validateFuzz,
  validateFinding,
  validateTestRecord,
  SEVERITIES,
  STATUSES,
};
