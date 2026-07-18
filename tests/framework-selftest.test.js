'use strict';

/**
 * The framework tests itself: assertions, deep equality, mocks, virtual
 * time and the sandbox loader. If this suite fails, no other result can
 * be trusted.
 */

const path = require('path');
const { describe, it, expect, mock, loadSandboxed, ExitError, AssertionError } = require('../testframework');

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

describe('sentinel: sandbox loader', () => {
  const FIXTURE = path.join(__dirname, '..', 'password-security.js');

  it('loads a real module fresh each time (no shared state)', () => {
    const first = loadSandboxed(FIXTURE).exports;
    const second = loadSandboxed(FIXTURE).exports;
    expect(typeof first.isAuthenticated).toBe('function');
    expect(first).not.toBe(second);
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
