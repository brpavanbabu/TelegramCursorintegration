'use strict';

/**
 * Sentinel Test Framework — JVM language adapter (Java + Kotlin)
 *
 * Strategy: on the JVM, JUnit + the project build tool are the native
 * execution environment, so Sentinel orchestrates rather than reimplements:
 *   - security & quality analysis of .java/.kt sources (Sentinel-native)
 *   - test execution through the project's own build tool
 *     (./gradlew > ./mvnw > gradle > mvn), parsing the JUnit XML results
 *     into Sentinel's unified report and traceability matrix
 *   - JaCoCo XML coverage ingestion when the build produces it
 *
 * Requirement linking: `[REQ-ID]` tags in @Test method names / display
 * names / class names flow into the same PASS/FAIL/UNCOVERED matrix.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseJUnitFile } = require('./junit-xml');

const JVM_RULES = [
  {
    id: 'jvm-hardcoded-credential',
    severity: 'high',
    pattern: /\b[A-Za-z0-9_.]*(password|passwd|secret|token|api[_-]?key)\s*[:=]+\s*"([^"\n]{6,})"/gi,
    filter: (m) => !/your|example|here|change|placeholder|sample|dummy|test[-_]?pass|fake|xxx|[<>]|System\.getenv/i.test(m[2]),
    message: 'Possible hardcoded credential (use environment/config injection)',
  },
  {
    id: 'jvm-command-injection-risk',
    severity: 'medium',
    pattern: /Runtime\.getRuntime\(\)\.exec\s*\(\s*("[^"]*"\s*\+|[A-Za-z_$])/g,
    message: 'Shell command built from dynamic input — use ProcessBuilder with an argument list',
  },
  {
    id: 'jvm-sql-injection-risk',
    severity: 'medium',
    pattern: /"(SELECT|INSERT|UPDATE|DELETE)\b[^"\n]*"\s*\+/gi,
    message: 'SQL built by string concatenation — use PreparedStatement parameters',
  },
  {
    id: 'jvm-weak-hash',
    severity: 'low',
    pattern: /MessageDigest\.getInstance\s*\(\s*"(MD5|SHA-?1)"/gi,
    message: 'Weak hash algorithm for security purposes — prefer SHA-256+',
  },
  {
    id: 'jvm-tls-verification-disabled',
    severity: 'high',
    pattern: /ALLOW_ALL_HOSTNAME_VERIFIER|TrustAllCerts|setHostnameVerifier\s*\(\s*\(?[^)]*->\s*true|checkServerTrusted\s*\([^)]*\)\s*\{\s*\}/g,
    message: 'TLS certificate/hostname verification disabled',
  },
  {
    id: 'jvm-printstacktrace',
    severity: 'info',
    pattern: /\.printStackTrace\s*\(\s*\)/g,
    message: 'printStackTrace() instead of proper logging/handling',
  },
  {
    id: 'jvm-debug-todo',
    severity: 'info',
    pattern: /\/\/\s*(TODO|FIXME|HACK|XXX)\b/gi,
    message: 'Unresolved TODO/FIXME marker',
  },
];

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'build', 'target', 'out', '.gradle', '.idea',
  '.testreports', 'testframework',
]);

function walkSources(root, out = [], dir = root) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDE_DIRS.has(entry.name) && !entry.name.startsWith('.')) walkSources(root, out, full);
    } else if (entry.isFile() && /\.(java|kt|kts)$/.test(entry.name) && !entry.name.endsWith('.gradle.kts')) {
      out.push(full);
    }
  }
  return out;
}

function detect(root) {
  if (walkSources(root).length > 0) return true;
  return ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']
    .some((f) => fs.existsSync(path.join(root, f)));
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === '\n') line++;
  return line;
}

function analyze(root) {
  const files = walkSources(root);
  const findings = [];
  for (const file of files) {
    const rel = path.relative(root, file);
    const source = fs.readFileSync(file, 'utf8');
    for (const rule of JVM_RULES) {
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      let m;
      while ((m = re.exec(source)) !== null) {
        if (rule.filter && !rule.filter(m)) continue;
        const line = lineOf(source, m.index);
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          file: rel,
          line,
          excerpt: (source.split('\n')[line - 1] || '').trim().slice(0, 160),
          message: rule.message,
        });
        if (re.lastIndex === m.index) re.lastIndex++;
      }
    }
  }
  return { language: 'jvm', scannedFiles: files.length, findings };
}

function binaryAvailable(bin) {
  const res = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 60000 });
  return res.status === 0;
}

/** Pick the build command the project itself would use. */
function pickBuildCommand(root) {
  const hasGradleBuild = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']
    .some((f) => fs.existsSync(path.join(root, f)));
  const hasMaven = fs.existsSync(path.join(root, 'pom.xml'));

  if (hasGradleBuild && fs.existsSync(path.join(root, 'gradlew'))) return { cmd: './gradlew', args: ['test', '--console=plain'], tool: 'gradle' };
  if (hasMaven && fs.existsSync(path.join(root, 'mvnw'))) return { cmd: './mvnw', args: ['-B', '-q', 'test'], tool: 'maven' };
  if (hasGradleBuild && binaryAvailable('gradle')) return { cmd: 'gradle', args: ['test', '--console=plain'], tool: 'gradle' };
  if (hasMaven && binaryAvailable('mvn')) return { cmd: 'mvn', args: ['-B', '-q', 'test'], tool: 'maven' };
  return null;
}

function findResultXmls(root) {
  const found = [];
  const search = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.git', '.gradle', 'src'].includes(entry.name)) continue;
        search(full, depth + 1);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.xml') &&
        (full.includes(`test-results${path.sep}`) || full.includes(`surefire-reports${path.sep}`)) &&
        entry.name.startsWith('TEST-')
      ) {
        found.push(full);
      }
    }
  };
  search(root, 0);
  return found;
}

function findJacocoXml(root) {
  for (const candidate of [
    path.join(root, 'build', 'reports', 'jacoco', 'test', 'jacocoTestReport.xml'),
    path.join(root, 'target', 'site', 'jacoco', 'jacoco.xml'),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function parseJacoco(xmlPath) {
  const xml = fs.readFileSync(xmlPath, 'utf8');
  // The LAST report-level LINE counter aggregates the whole build.
  const counters = [...xml.matchAll(/<counter\s+type="LINE"\s+missed="(\d+)"\s+covered="(\d+)"/g)];
  if (counters.length === 0) return null;
  const last = counters[counters.length - 1];
  const missed = parseInt(last[1], 10);
  const covered = parseInt(last[2], 10);
  return {
    linesCovered: covered,
    linesMissed: missed,
    linePct: Math.round((covered / Math.max(1, covered + missed)) * 1000) / 10,
  };
}

/**
 * Run the project's JVM tests via its build tool and ingest the results.
 */
function runTests(root, options = {}) {
  const build = pickBuildCommand(root);
  if (!build) {
    const hasSources = walkSources(root).length > 0;
    return {
      tests: [],
      skippedReason: hasSources
        ? 'no usable build tool found (need gradlew/mvnw or gradle/mvn on PATH with a build file)'
        : null,
    };
  }

  const result = spawnSync(build.cmd, build.args, {
    encoding: 'utf8',
    cwd: root,
    timeout: options.timeoutMs || 600000,
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });

  const xmls = findResultXmls(root);
  const tests = [];
  for (const xml of xmls) {
    try {
      tests.push(...parseJUnitFile(xml, { suitePrefix: 'jvm' }));
    } catch (e) {
      /* unparsable file — skip */
    }
  }

  const jacocoPath = findJacocoXml(root);
  const coverage = jacocoPath ? parseJacoco(jacocoPath) : null;

  if (tests.length === 0) {
    const tail = String((result.stderr || '') + (result.stdout || '')).split('\n').filter(Boolean).slice(-5).join(' | ');
    return {
      tests: [],
      skippedReason: `build tool "${build.tool}" produced no JUnit XML (exit ${result.status}): ${tail.slice(0, 300)}`,
      coverage,
    };
  }
  return { tests, runner: build.tool, coverage, buildExit: result.status };
}

module.exports = { detect, analyze, runTests, JVM_RULES, pickBuildCommand };
