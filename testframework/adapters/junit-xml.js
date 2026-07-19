'use strict';

/**
 * Sentinel Test Framework — JUnit XML result parser
 *
 * JUnit XML is the lingua franca of test results: pytest, Gradle, Maven
 * Surefire, Kotlin test and virtually every CI-aware runner emits it.
 * Parsing it lets Sentinel ingest results from ANY language ecosystem and
 * feed them into the same traceability matrix and reporters.
 *
 * Requirement linking convention for non-JS tests: put `[REQ-ID]` tags in
 * the test name, class name or display name, e.g.
 *   def test_lockout_after_three_attempts_SEC002(self):   # [SEC-002]
 *   @Test fun `locks after 3 attempts [SEC-002]`() { ... }
 */

const fs = require('fs');

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

function decode(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m]);
}

function parseAttrs(attrText) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(attrText)) !== null) attrs[m[1]] = decode(m[2]);
  return attrs;
}

function extractReqTags(...texts) {
  const reqs = new Set();
  for (const text of texts) {
    if (!text) continue;
    const re = /\[([A-Z][A-Z0-9]{1,15}-\d{1,6})\]/g;
    let m;
    while ((m = re.exec(text)) !== null) reqs.add(m[1]);
    // also match bare SEC001 / SEC_001 style suffixes in snake_case names
    const re2 = /_([A-Z]{2,10})_?(\d{1,6})(?:_|$)/g;
    while ((m = re2.exec(text)) !== null) reqs.add(`${m[1]}-${String(m[2]).padStart(3, '0')}`);
  }
  return [...reqs];
}

/**
 * Parse a JUnit XML string into Sentinel test-result records.
 * @param {string} xml
 * @param {object} opts { suitePrefix }
 */
function parseJUnitXml(xml, opts = {}) {
  const prefix = opts.suitePrefix ? `${opts.suitePrefix} > ` : '';
  const tests = [];
  const caseRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = caseRe.exec(xml)) !== null) {
    const attrs = parseAttrs(m[1]);
    const body = m[2] || '';
    const name = attrs.name || '(unnamed)';
    const classname = attrs.classname || attrs.class || '';
    const duration = Math.round(parseFloat(attrs.time || '0') * 1000) || 0;

    let status = 'passed';
    let error = null;

    const failure = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    if (failure) {
      status = 'failed';
      const fAttrs = parseAttrs(failure[2]);
      error = {
        name: fAttrs.type || failure[1],
        message: decode(fAttrs.message || '').slice(0, 500) || decode((failure[3] || '').trim()).slice(0, 500),
        stack: decode((failure[3] || '').trim()).split('\n').slice(0, 10).join('\n'),
      };
    } else if (/<skipped\b/.test(body)) {
      status = 'skipped';
    }

    tests.push({
      suite: prefix + (classname || '(suite)'),
      name,
      fullName: `${prefix}${classname ? classname + ' > ' : ''}${name}`,
      status,
      error,
      duration,
      retries: 0,
      reqs: extractReqTags(name, classname),
      file: null,
    });
  }
  return tests;
}

function parseJUnitFile(filePath, opts = {}) {
  return parseJUnitXml(fs.readFileSync(filePath, 'utf8'), opts);
}

module.exports = { parseJUnitXml, parseJUnitFile, extractReqTags, decode };
