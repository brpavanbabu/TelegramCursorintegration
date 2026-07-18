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
