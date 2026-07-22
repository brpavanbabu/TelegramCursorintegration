'use strict';

/**
 * The framework tests itself: assertions, deep equality, mocks, virtual
 * time and the sandbox loader. If this suite fails, no other result can
 * be trusted.
 */

const path = require('path');
const { describe, it, expect, mock, loadSandboxed, ExitError, AssertionError } = require('../testframework');
const { aggregateCoverage } = require('../testframework/core/coverage');

describe('sentinel: assertion engine', () => {
  it('toBe / toEqual distinguish identity from deep equality', () => {
    const a = { x: [1, 2, { y: new Date(1700000000000) }] };
    const b = { x: [1, 2, { y: new Date(1700000000000) }] };
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    expect(NaN).toBeNaN();
    expect([1, 2, 3]).toContain(2);
    expect('hello world').toMatch(/wor/);
    expect({ a: { b: 3 } }).toHaveProperty('a.b', 3);
  });

  it('deep equality covers Map/Set/Buffer/RegExp and rejects mismatches', () => {
    expect(new Set([1, { z: 2 }])).toEqual(new Set([{ z: 2 }, 1]));
    expect(new Map([['k', { v: 1 }]])).toEqual(new Map([['k', { v: 1 }]]));
    expect(Buffer.from('ab')).toEqual(Buffer.from('ab'));
    expect(/abc/g).toEqual(/abc/g);
    expect({ a: 1 }).not.toEqual({ a: 1, b: 2 });
  });

  it('Set equality is true multiset matching (regression: no double-matching one element)', () => {
    // Both size 2; the naive `.some()` matcher wrongly let both {x:1} items
    // match the single {x:1} in the other set. Must be NOT equal.
    expect(new Set([{ x: 1 }, { x: 1 }])).not.toEqual(new Set([{ x: 1 }, { y: 9 }]));
    expect(new Set([{ x: 1 }, { x: 1 }])).toEqual(new Set([{ x: 1 }, { x: 1 }]));
    expect(new Set([{ p: 1 }, { q: 2 }])).toEqual(new Set([{ q: 2 }, { p: 1 }]));
  });

  it('deep equality terminates on cyclic structures, including cycles through a Set', () => {
    const a = {}; a.self = a;
    const b = {}; b.self = b;
    expect(a).toEqual(b);

    const s1 = new Set(); const n1 = { tag: 1 }; n1.back = s1; s1.add(n1);
    const s2 = new Set(); const n2 = { tag: 1 }; n2.back = s2; s2.add(n2);
    expect(s1).toEqual(s2);
  });

  it('failed assertions throw AssertionError with a useful message', () => {
    expect(() => expect(1).toBe(2)).toThrow(AssertionError);
    expect(() => expect(1).toBe(2)).toThrow('expected 1 to be 2');
  });

  it('async matchers: resolves / rejects', async () => {
    await expect(Promise.resolve(41 + 1)).resolves.toBe(42);
    await expect(Promise.reject(new TypeError('nope'))).rejects.toThrow(TypeError);
    await expect(Promise.reject(new Error('boom goes'))).rejects.toThrow('boom');
  });
});

describe('sentinel: mock engine', () => {
  it('mock.fn records calls, supports queued implementations', () => {
    const f = mock.fn().mockReturnValue(1).mockReturnValueOnce(99);
    expect(f('a', { b: 2 })).toBe(99);
    expect(f()).toBe(1);
    expect(f).toHaveBeenCalledTimes(2);
    expect(f).toHaveBeenCalledWith('a', { b: 2 });
  });

  it('spyOn wraps and restores methods', () => {
    const target = { add: (a, b) => a + b };
    const spy = mock.spyOn(target, 'add');
    expect(target.add(2, 3)).toBe(5);
    expect(spy).toHaveBeenCalledWith(2, 3);
    spy.mockRestore();
    expect(target.add._isMockFunction).toBeUndefined();
  });

  it('autoStub: any method exists, is async, and records calls', async () => {
    const stub = mock.autoStub('bot');
    await stub.sendMessage(1, 'hi');
    await stub.whateverMethodYouLike('x');
    expect(stub.__calls).toHaveLength(2);
    expect(stub.__calls[0].method).toBe('bot.sendMessage');
  });

  it('FakeClock drives setTimeout/setInterval/Date deterministically', () => {
    const clock = new mock.FakeClock({ now: 1000 });
    const fired = [];
    clock.fns.setTimeout(() => fired.push('t1'), 500);
    const intervalId = clock.fns.setInterval(() => fired.push('i'), 200);
    clock.tick(600);
    // interval fires at 1200, 1400, 1600; timeout at 1500 — strict time order
    expect(fired).toEqual(['i', 'i', 't1', 'i']);
    expect(new (clock.fns.Date)().getTime()).toBe(1600);
    expect(clock.fns.Date.now()).toBe(1600);
    clock.fns.clearInterval(intervalId);
    clock.tick(1000);
    expect(fired).toHaveLength(4);
  });
});

describe('sentinel: coverage aggregation', () => {
  it('overall byte coverage is byte-weighted, not an unweighted mean (regression)', () => {
    // 4000-byte file at 30% + 40-byte file at 100%.
    // Unweighted mean would be (30+100)/2 = 65% and overstate coverage.
    // Byte-weighted truth = (1200+40)/(4000+40) ≈ 30.7%.
    const files = [
      { coveredBytes: 1200, totalBytes: 4000, bytePct: 30, functionsTotal: 0, functionsCovered: 0 },
      { coveredBytes: 40, totalBytes: 40, bytePct: 100, functionsTotal: 0, functionsCovered: 0 },
    ];
    const overall = aggregateCoverage(files);
    expect(overall.bytePct).toBe(30.7);
    expect(overall.bytePct).toBeLessThan(65);
  });

  it('ignores rows without byte counts (e.g. ingested from another language)', () => {
    const files = [
      { coveredBytes: 50, totalBytes: 100, functionsTotal: 2, functionsCovered: 1 },
      { bytePct: 88, functionsTotal: 0, functionsCovered: 0 }, // JaCoCo-style row, no byte counts
    ];
    const overall = aggregateCoverage(files);
    expect(overall.bytePct).toBe(50);
    expect(overall.functionPct).toBe(50);
  });
});

describe('sentinel: sandbox loader', () => {
  const FIXTURE = path.join(__dirname, '..', 'password-security.js');

  it('loads a real module fresh each time (no shared state)', () => {
    const first = loadSandboxed(FIXTURE).exports;
    const second = loadSandboxed(FIXTURE).exports;
    expect(typeof first.isAuthenticated).toBe('function');
    expect(first).not.toBe(second);
  });

  it('fake process does not expose the real process.exit via its prototype (regression)', () => {
    const os = require('os');
    const fs = require('fs');
    const tmp = path.join(os.tmpdir(), `sentinel-proto-${process.pid}.js`);
    // Sandboxed code tries to escape the fake process by walking the prototype
    // chain. The fake must be a flat object with no chain back to real process.
    fs.writeFileSync(
      tmp,
      'const proto = Object.getPrototypeOf(process);' +
        'module.exports = { escaped: proto && typeof proto.exit === "function", ' +
        'protoIsObject: proto === Object.prototype || proto === null };'
    );
    try {
      const { exports } = loadSandboxed(tmp);
      expect(exports.escaped).toBe(false);
      expect(exports.protoIsObject).toBe(true);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('process.exit inside sandboxed code throws catchable ExitError', () => {
    const os = require('os');
    const fs = require('fs');
    const tmp = path.join(os.tmpdir(), `sentinel-exit-${process.pid}.js`);
    fs.writeFileSync(tmp, 'process.exit(3);');
    try {
      let caught = null;
      try {
        loadSandboxed(tmp);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ExitError);
      expect(caught.code).toBe(3);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('require() stubbing replaces dependencies by specifier', () => {
    const os = require('os');
    const fs = require('fs');
    const tmp = path.join(os.tmpdir(), `sentinel-stub-${process.pid}.js`);
    fs.writeFileSync(tmp, "const dep = require('some-external-lib'); module.exports = { value: dep.magic };");
    try {
      const { exports } = loadSandboxed(tmp, { stubs: { 'some-external-lib': { magic: 7 } } });
      expect(exports.value).toBe(7);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
