'use strict';

/**
 * Sentinel Test Framework — Static & Security Analyzer
 *
 * Requirement-free automatic testing: every run scans the whole project for
 * syntax errors, committed secrets, injection risks and quality smells —
 * the checks a human tester/security reviewer would do by hand.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, info: 3 };

const RULES = [
  {
    id: 'telegram-token-committed',
    severity: 'high',
    files: /\.(js|json|md|ps1|txt|env|yml|yaml)$/i,
    pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
    message: 'Telegram bot token appears to be committed to the repository',
  },
  {
    id: 'aws-access-key',
    severity: 'high',
    files: /\.(js|json|md|ps1|txt|env|yml|yaml)$/i,
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    message: 'AWS access key ID committed to the repository',
  },
  {
    id: 'private-key-block',
    severity: 'high',
    files: /./,
    pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    message: 'Private key material committed to the repository',
  },
  {
    id: 'hardcoded-credential',
    severity: 'high',
    files: /\.(js|ts|json|ps1)$/i,
    pattern: /\b[A-Za-z0-9_.]*(password|passwd|secret|token|api[_-]?key)\s*[:=]+\s*['"]([^'"\n]{6,})['"]/gi,
    filter: (match) => {
      const value = match[2];
      if (/your|example|here|change|placeholder|sample|dummy|test[-_]?pass|fake|xxx|[<>]|^\$|process\.env/i.test(value)) return false;
      return true;
    },
    message: 'Possible hardcoded credential (move to config/environment, never commit real values)',
  },
  {
    id: 'default-credential-fallback',
    severity: 'medium',
    files: /\.(js|ts)$/i,
    pattern: /\b[A-Za-z0-9_.]*(password|passwd|secret|token)\s*\|\|\s*['"]([^'"\n]{4,})['"]/gi,
    message: 'Secret falls back to a hardcoded default when missing from config — fail fast instead of using a known default',
  },
  {
    id: 'no-eval',
    severity: 'high',
    files: /\.(js|ts)$/i,
    pattern: /\beval\s*\(|new\s+Function\s*\(/g,
    message: 'eval()/new Function() enables arbitrary code execution',
  },
  {
    id: 'command-injection-risk',
    severity: 'medium',
    files: /\.(js|ts)$/i,
    pattern: /\bexec(?:Sync)?\s*\(\s*(`[^`]*\$\{|['"][^'"]*['"]\s*\+)/g,
    message: 'Shell command built from dynamic input — validate/escape or use execFile with an argument array',
  },
  {
    id: 'timing-unsafe-compare',
    severity: 'low',
    files: /\.(js|ts)$/i,
    pattern: /\b(password|token|secret)\w*\s*===|===\s*(correct|expected)?(password|token|secret)/gi,
    message: 'Non-constant-time comparison of a secret — prefer crypto.timingSafeEqual()',
  },
  {
    id: 'empty-catch',
    severity: 'low',
    files: /\.(js|ts)$/i,
    pattern: /catch\s*(\([^)]*\))?\s*\{\s*\}/g,
    message: 'Empty catch block silently swallows errors',
  },
  {
    id: 'debug-todo',
    severity: 'info',
    files: /\.(js|ts)$/i,
    pattern: /\/\/\s*(TODO|FIXME|HACK|XXX)\b/gi,
    message: 'Unresolved TODO/FIXME marker',
  },
];

const DEFAULT_EXCLUDE_DIRS = new Set(['node_modules', '.git', '.testreports', 'reports']);

function walk(dir, excludeDirs, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.git')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!excludeDirs.has(entry.name)) walk(full, excludeDirs, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

function scan(rootDir, options = {}) {
  const root = path.resolve(rootDir);
  const excludeDirs = new Set([...DEFAULT_EXCLUDE_DIRS, ...(options.excludeDirs || [])]);
  const excludeFiles = (options.excludeFiles || []).map((p) => path.resolve(root, p));
  const files = walk(root, excludeDirs).filter((f) => !excludeFiles.includes(f));

  const findings = [];

  for (const file of files) {
    const rel = path.relative(root, file);
    // The framework analyses the application, not itself/its tests.
    if (options.skipSelf !== false && (rel.startsWith('testframework' + path.sep) || rel.startsWith('tests' + path.sep))) {
      continue;
    }
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (e) {
      continue;
    }
    if (source.length > 2_000_000) continue;

    for (const rule of RULES) {
      if (!rule.files.test(rel)) continue;
      const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g');
      let match;
      while ((match = re.exec(source)) !== null) {
        if (rule.filter && !rule.filter(match, rel)) continue;
        const line = lineOf(source, match.index);
        const lineText = source.split('\n')[line - 1] || '';
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          file: rel,
          line,
          excerpt: lineText.trim().slice(0, 160),
          message: rule.message,
        });
        if (re.lastIndex === match.index) re.lastIndex++;
      }
    }
  }

  // Syntax validation of every JS file (including framework + tests).
  const syntaxResults = [];
  for (const file of files.filter((f) => f.endsWith('.js'))) {
    const rel = path.relative(root, file);
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 15000 });
    const ok = result.status === 0;
    syntaxResults.push({ file: rel, ok, error: ok ? null : String(result.stderr || '').split('\n').slice(0, 3).join(' ').trim() });
    if (!ok) {
      findings.push({
        rule: 'syntax-error',
        severity: 'high',
        file: rel,
        line: 0,
        excerpt: '',
        message: `File does not parse: ${String(result.stderr || '').split('\n')[0]}`,
      });
    }
  }

  // JSON validation.
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    const rel = path.relative(root, file);
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      findings.push({
        rule: 'invalid-json',
        severity: 'high',
        file: rel,
        line: 0,
        excerpt: '',
        message: `Invalid JSON: ${err.message}`,
      });
    }
  }

  findings.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || a.file.localeCompare(b.file) || a.line - b.line);

  const counts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  return {
    scannedFiles: files.length,
    syntaxChecked: syntaxResults.length,
    syntaxFailures: syntaxResults.filter((s) => !s.ok),
    findings,
    counts,
  };
}

module.exports = { scan, RULES, SEVERITY_ORDER };
