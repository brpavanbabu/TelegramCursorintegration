'use strict';

/**
 * Sentinel Test Framework — Coverage Collector
 *
 * In-process V8 precise coverage via the inspector protocol. No external
 * tooling. Reports byte (statement) coverage and function coverage per file,
 * plus best-effort uncovered line ranges. Files loaded through the sandbox
 * loader (vm.compileFunction) are covered too.
 */

const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');

class CoverageCollector {
  constructor(projectRoot, { exclude = [] } = {}) {
    this.root = path.resolve(projectRoot);
    this.exclude = exclude.map((p) => (p instanceof RegExp ? p : new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))));
    this.session = null;
    this.available = true;
  }

  _post(method, params) {
    return new Promise((resolve, reject) => {
      this.session.post(method, params, (err, result) => (err ? reject(err) : resolve(result)));
    });
  }

  async start() {
    try {
      const inspector = require('inspector');
      this.session = new inspector.Session();
      this.session.connect();
      await this._post('Profiler.enable');
      await this._post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
    } catch (err) {
      this.available = false;
      this.error = err.message;
    }
  }

  async stop() {
    if (!this.available || !this.session) return null;
    try {
      const { result } = await this._post('Profiler.takePreciseCoverage');
      await this._post('Profiler.stopPreciseCoverage');
      this.session.disconnect();
      return result;
    } catch (err) {
      this.available = false;
      this.error = err.message;
      return null;
    }
  }

  _urlToPath(url) {
    if (!url) return null;
    if (url.startsWith('file://')) {
      try {
        return fileURLToPath(url);
      } catch (e) {
        return null;
      }
    }
    if (path.isAbsolute(url)) return url;
    return null;
  }

  _included(filePath) {
    if (!filePath.startsWith(this.root + path.sep)) return false;
    const rel = path.relative(this.root, filePath);
    if (rel.includes('node_modules')) return false;
    return !this.exclude.some((re) => re.test(rel) || re.test(filePath));
  }

  /**
   * @param {Array} v8Result Profiler.takePreciseCoverage result array
   * @param {Array<string>} productFiles absolute paths that SHOULD be covered;
   *        files never loaded are reported at 0%.
   */
  summarize(v8Result, productFiles = []) {
    const byFile = new Map();

    if (v8Result) {
      for (const script of v8Result) {
        const filePath = this._urlToPath(script.url);
        if (!filePath || !this._included(filePath)) continue;
        if (!fs.existsSync(filePath)) continue;

        let entry = byFile.get(filePath);
        const scriptEnd = Math.max(
          1,
          ...script.functions.flatMap((f) => f.ranges.map((r) => r.endOffset))
        );
        if (!entry) {
          entry = { covered: new Uint8Array(scriptEnd), length: scriptEnd, functions: new Map() };
          byFile.set(filePath, entry);
        } else if (scriptEnd > entry.length) {
          const grown = new Uint8Array(scriptEnd);
          grown.set(entry.covered);
          entry.covered = grown;
          entry.length = scriptEnd;
        }

        // Apply ranges: larger ranges first so nested (more precise) ranges win.
        const allRanges = [];
        for (const fn of script.functions) {
          for (const range of fn.ranges) {
            allRanges.push(range);
          }
          const key = `${fn.functionName || '(anonymous)'}@${fn.ranges[0] ? fn.ranges[0].startOffset : 0}`;
          const called = fn.ranges[0] && fn.ranges[0].count > 0;
          if (!entry.functions.has(key) || called) {
            entry.functions.set(key, { name: fn.functionName || '(anonymous)', called: !!called });
          }
        }
        allRanges.sort((a, b) => (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset));
        for (const range of allRanges) {
          const value = range.count > 0 ? 1 : 0;
          const end = Math.min(range.endOffset, entry.length);
          // merge across multiple loads: once covered, stays covered only if
          // this range is a fresh uncovered marker within THIS script pass —
          // we conservatively OR coverage across script instances.
          if (value === 1) {
            entry.covered.fill(1, range.startOffset, end);
          } else if (!entry.merged) {
            entry.covered.fill(0, range.startOffset, end);
          }
        }
        entry.merged = true;
      }
    }

    const files = [];
    const seen = new Set();

    const pushEntry = (filePath, entry) => {
      seen.add(filePath);
      let coveredBytes = 0;
      let totalBytes = 0;
      let source = '';
      try {
        source = fs.readFileSync(filePath, 'utf8');
      } catch (e) {
        /* unreadable */
      }

      let uncoveredLines = [];
      if (entry) {
        for (let i = 0; i < entry.length; i++) {
          totalBytes++;
          if (entry.covered[i]) coveredBytes++;
        }
        uncoveredLines = approximateUncoveredLines(source, entry);
      } else {
        totalBytes = Math.max(1, source.length);
      }

      const fns = entry ? [...entry.functions.values()] : [];
      const fnTotal = fns.length;
      const fnCovered = fns.filter((f) => f.called).length;

      files.push({
        file: path.relative(this.root, filePath),
        bytePct: entry ? Math.round((coveredBytes / Math.max(1, totalBytes)) * 1000) / 10 : 0,
        coveredBytes,
        totalBytes,
        functionsTotal: fnTotal,
        functionsCovered: fnCovered,
        functionPct: fnTotal > 0 ? Math.round((fnCovered / fnTotal) * 1000) / 10 : entry ? 100 : 0,
        loaded: !!entry,
        uncoveredLines: uncoveredLines.slice(0, 25),
      });
    };

    for (const [filePath, entry] of byFile) pushEntry(filePath, entry);
    for (const product of productFiles) {
      const abs = path.resolve(product);
      if (!seen.has(abs) && this._included(abs) && fs.existsSync(abs)) pushEntry(abs, null);
    }

    files.sort((a, b) => a.file.localeCompare(b.file));

    return {
      available: this.available,
      error: this.error || null,
      files,
      overall: aggregateCoverage(files),
    };
  }
}

/**
 * Aggregate per-file coverage into an overall figure.
 *
 * Byte coverage is byte-WEIGHTED — sum(covered)/sum(total) — NOT an unweighted
 * mean of per-file percentages. A tiny 100%-covered file must not mask a large
 * barely-covered one. Rows without byte counts (e.g. coverage ingested from
 * another language's tool) are excluded from the byte aggregate.
 */
function aggregateCoverage(files) {
  const totals = files.reduce(
    (acc, f) => {
      acc.fnTotal += f.functionsTotal || 0;
      acc.fnCovered += f.functionsCovered || 0;
      acc.coveredBytes += f.coveredBytes || 0;
      acc.totalBytes += f.totalBytes || 0;
      return acc;
    },
    { fnTotal: 0, fnCovered: 0, coveredBytes: 0, totalBytes: 0 }
  );
  return {
    bytePct: totals.totalBytes ? Math.round((totals.coveredBytes / totals.totalBytes) * 1000) / 10 : 0,
    functionPct: totals.fnTotal ? Math.round((totals.fnCovered / totals.fnTotal) * 1000) / 10 : 0,
  };
}

/**
 * Best-effort mapping of uncovered byte ranges back to source lines.
 * V8 offsets include the module wrapper header, so we estimate the header
 * length from the difference between script length and file length.
 */
function approximateUncoveredLines(source, entry) {
  if (!source) return [];
  const headerAdjust = Math.max(0, entry.length - source.length - 3);
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') lineStarts.push(i + 1);
  }
  const offsetToLine = (offset) => {
    const adjusted = Math.min(Math.max(0, offset - headerAdjust), source.length - 1);
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (lineStarts[mid] <= adjusted) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const lines = new Set();
  let runStart = -1;
  for (let i = 0; i <= entry.length; i++) {
    const uncovered = i < entry.length && entry.covered[i] === 0;
    if (uncovered && runStart === -1) runStart = i;
    if (!uncovered && runStart !== -1) {
      if (i - runStart > 5) {
        const from = offsetToLine(runStart);
        const to = offsetToLine(i - 1);
        for (let ln = from; ln <= to && lines.size < 200; ln++) {
          const text = source.slice(lineStarts[ln - 1], lineStarts[ln] || source.length).trim();
          if (text && !text.startsWith('//') && !text.startsWith('*') && !text.startsWith('/*')) lines.add(ln);
        }
      }
      runStart = -1;
    }
  }
  return [...lines].sort((a, b) => a - b);
}

module.exports = { CoverageCollector, aggregateCoverage };
