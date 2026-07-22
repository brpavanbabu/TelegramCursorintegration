# 🛡️ Sentinel Test Framework

**Autonomous, requirement-driven testing for any Node.js project. Zero dependencies.**

Sentinel is not a test *library* — it is a complete testing *system* designed to do the
work a human tester does, automatically:

| Layer | What it replaces | How |
|---|---|---|
| **Test runner** | Manual test execution | `describe/it`, hooks, timeouts, retries, only/skip/todo, parallel-safe file isolation |
| **Assertions** | Eyeballing output | Jest-compatible `expect()` with deep equality, `.not`, `.resolves/.rejects`, mock matchers |
| **Mock engine** | Manual doubles | `mock.fn()`, `mock.spyOn()`, `mock.autoStub()` (deep proxy), `mock.FakeClock` (virtual time) |
| **Sandbox loader** | "Can't test this, it needs prod!" | Loads any CommonJS module with stubbed `require`, `fs`, `process.exit`, timers, `Date` — native modules and network clients never load |
| **Requirements engine** | Manual test-plan tracing | Machine-readable requirements → executable checks → PASS / FAIL / UNCOVERED traceability matrix |
| **Auto test generator** | Exploratory testing | Discovers modules, reflects exports, attacks every function with edge cases + seeded fuzzing, pins observed behavior as regression suites |
| **Security analyzer** | Security review pass | Committed secrets, injection risks, `eval`, timing-unsafe compares, syntax/JSON validation |
| **Coverage** | "Did we test everything?" | In-process V8 precise coverage — byte + function level, flags never-loaded files |
| **Reporters** | Status meetings | Console, JSON, JUnit XML (CI), self-contained HTML report |

Everything runs on plain Node.js ≥ 14. **No npm packages. No network. No native builds.**

---

## Polyglot: JavaScript, Python, Java, Kotlin

Sentinel's orchestration layers (requirements matrix, security analysis, fuzz
strategy, reporting, verdict) are language-agnostic. Language adapters plug
each ecosystem into the same pipeline — results from every language merge into
**one report, one traceability matrix, one verdict**:

| Language | Analysis | Fuzzing | Test execution | Coverage |
|---|---|---|---|---|
| JavaScript | ✅ native | ✅ native (sandbox) | ✅ native runner | ✅ V8 in-process (byte-weighted) |
| Python | ✅ rules + `py_compile` | ✅ stdlib harness (AST-screened safe imports) | ✅ pytest (JUnit XML) or stdlib unittest | ✅ dependency-free `sys.settrace` (opt-in: `"python": { "coverage": true }`) |
| Java | ✅ rules (`.java`) | ⚠️ not implemented — relies on hand-written JUnit tests | ✅ Gradle/Maven → JUnit XML ingested | ✅ JaCoCo XML ingested |
| Kotlin | ✅ rules (`.kt`) | ⚠️ not implemented — relies on hand-written JUnit tests | ✅ same Gradle/Maven flow | ✅ JaCoCo XML ingested |

> **Honest scope:** JVM *fuzzing* is not implemented (it would need a reflection-based
> JUnit generator or a Java agent) — the JVM path runs your existing tests and analyzes
> sources. Every other cell above is implemented and covered by the framework's own
> test suite.

Languages are **auto-detected** (`discover` shows what was found); force on/off
per language with `"languages": { "python": false }` in the config.

**Cross-language requirement linking**: tag any test name with `[SEC-002]`
(or a `_SEC002` suffix in snake_case/camelCase names) and it links into the
traceability matrix exactly like a JS test tagged with `reqs: ['SEC-002']`:

```python
def test_lockout_after_three_failures_SEC002(self): ...   # Python
```
```java
@Test public void locksAfterThreeFailedAttempts_SEC002() { ... }  // Java
```
```kotlin
@Test fun `locks after 3 attempts [SEC-002]`() { ... }            // Kotlin
```

**Adding a language** = writing one adapter (`adapters/<lang>.js`) that exposes
`detect(root)` plus any of `analyze` / `fuzz` / `runTests`, returning Sentinel's
shared record shapes. The contract is written down and **enforced at runtime** in
`adapters/contract.js` — a malformed adapter result fails loudly at the merge
boundary (with the exact field at fault) instead of silently mis-rendering.

The Python fuzzer only auto-imports modules that pass an AST safety screen
(stdlib-only imports, no top-level side effects) — the same safety rule the
JS auto-discovery applies. JVM tests always run through the project's own
build tool (`./gradlew` → `./mvnw` → `gradle` → `mvn`), so Sentinel never
fights the build system.

---

## Quick start — in ANY project

```bash
# 1. copy the testframework/ directory into your project root
cp -r testframework/ /path/to/your-project/

# 2. bootstrap config, requirements skeleton and an example test
cd /path/to/your-project
node testframework/cli.js init

# 3. see what Sentinel detected on its own
node testframework/cli.js discover

# 4. run the full autonomous pipeline
node testframework/cli.js all
```

Even with **zero hand-written tests**, `all` already gives you:
static & security analysis, syntax/JSON validation, autonomous fuzzing of every
safely-loadable module, and a requirements matrix.

## CLI

```
node testframework/cli.js <command> [options]

all        analyze + tests + coverage + fuzz + requirements matrix  (default)
run        test suites only (+coverage)
analyze    static & security analysis
generate   auto-discover + fuzz modules; --write pins regression suites
matrix     requirements traceability matrix
discover   show what was auto-detected
init       bootstrap a new project

--filter=TEXT   run only matching tests        --bail        stop on first failure
--seed=N        deterministic fuzz seed        --strict      findings/crashes fail the run
--verbose       verbose output                 --no-coverage skip coverage
--json[=F] --junit[=F] --html[=F]              write reports (default: .testreports/)
```

Exit code is `0` only when tests pass and no requirement fails — wire `npm test`
straight into CI. With `--strict`, high-severity security findings and fuzz
crashes fail the build too.

## Writing tests

```js
const { describe, it, expect, beforeEach, mock, loadSandboxed } = require('../testframework');

describe('checkout', { reqs: ['PAY-001'] }, () => {      // ← link to requirements
  it('charges the exact amount', async () => {
    const gateway = mock.autoStub('gateway');            // any method exists & records
    await checkout(gateway, { amount: 100 });
    expect(gateway.__calls[0].args[0]).toEqual({ amount: 100 });
  });

  it('locks out after timeout', () => {
    const clock = new mock.FakeClock({ now: 0 });
    const mod = loadSandboxed('./session.js', { Date: clock.fns.Date });
    clock.tick(30 * 60 * 1000);                          // 30 virtual minutes, 0 real ms
    expect(mod.exports.isExpired()).toBe(true);
  });
});
```

### Testing the untestable (sandbox loader)

> **What the sandbox is — and isn't.** `loadSandboxed` is a **controllability**
> tool, not a security boundary. It runs in the same V8 realm as the framework
> (via `vm.compileFunction`), so it shares `Object.prototype` with the host and
> is **not** safe to point at untrusted code. Its job is to make your *own*
> modules testable by swapping their `require`/`fs`/`process`/timers/`Date`.
> The fake `process` is a flat object (no prototype chain back to the real one),
> so `process.exit()` throws a catchable `ExitError` instead of killing the run.


```js
const { exports, console: logs } = loadSandboxed('./server.js', {
  stubs: { 'node-telegram-bot-api': FakeBot, robotjs: {}, child_process: { exec: myStub } },
  fs: { existsSync: () => true, readFileSync: () => '{"cfg":1}' },
  timers: clock.fns,          // virtual setInterval/setTimeout
  Date: clock.fns.Date,       // virtual time
});
// process.exit() inside the module throws catchable ExitError instead of killing the run
```

## Requirements as executable tests

`requirements/requirements.json`:

```json
{
  "project": "My App",
  "requirements": [
    {
      "id": "SEC-002",
      "title": "At most 3 failed password attempts before lockout",
      "priority": "critical",
      "verify": [
        { "type": "constant_equals", "file": "auth.js", "export": "MAX_ATTEMPTS", "equals": 3 }
      ]
    }
  ]
}
```

Check types: `file_exists`, `file_missing`, `source_contains`, `source_not_contains`,
`json_path`, `package_script`, `module_exports`, `constant_equals`, `function_returns`,
`syntax_ok`, `no_findings` (joins the security analyzer). Hand-written tests link via
`reqs: ['SEC-002']` metadata. Every requirement ends up **PASS**, **FAIL**, or
**UNCOVERED** — uncovered requirements are your missing test plan, computed for you.

## Autonomous fuzzing

`generate` discovers every module whose dependencies are Node built-ins, reflects its
exported functions, and attacks each parameter with 26 adversarial inputs (injection
strings, prototype-pollution payloads, 10k-char strings, BigInt, NaN, …) plus seeded
random combinations. Dependency-shaped parameters (`bot`, `client`, `logger`, …) get
recording auto-stubs automatically. Deterministic: same seed ⇒ same run.

`generate --write` pins the observed edge-case behavior into
`tests/generated/*.autogen.test.js` — future changes that alter edge-case behavior
fail the suite until you review and regenerate.

## Design guarantees

- **Fresh state**: sandbox loads give every test an isolated module instance.
- **No silent hangs**: a test that never settles *fails with a timeout* — the process
  can never drain its event loop and exit 0 mid-run.
- **File isolation**: root-level hooks in one test file never leak into another.
- **Determinism**: virtual clocks and seeded fuzzing make every run reproducible.

## Proven on a real project

This repository is Sentinel's reference deployment: the Telegram + Cursor bot is
tested end-to-end (auth gate, lockout timing, command pipeline, concurrency guard,
30-second monitoring loops) **without Telegram, Windows, PowerShell or robotjs** —
the entire bot runs inside the sandbox on any OS, with 30s monitor loops finishing
in milliseconds of virtual time.
