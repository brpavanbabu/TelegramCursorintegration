'use strict';

/**
 * Sentinel Test Framework — Assertion Engine
 *
 * Zero-dependency, Jest-compatible `expect()` API with deep equality,
 * negation (`.not`), async matchers (`.resolves` / `.rejects`) and
 * mock-function matchers.
 */

const util = require('util');

class AssertionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AssertionError';
    this.actual = details.actual;
    this.expected = details.expected;
    this.operator = details.operator;
  }
}

function fmt(value) {
  try {
    return util.inspect(value, {
      depth: 4,
      breakLength: 80,
      maxArrayLength: 20,
      maxStringLength: 300,
      compact: true,
    });
  } catch (e) {
    return String(value);
  }
}

function isPrimitive(v) {
  return v === null || (typeof v !== 'object' && typeof v !== 'function');
}

function deepEqual(a, b, seen = new Map()) {
  if (Object.is(a, b)) return true;
  if (isPrimitive(a) || isPrimitive(b)) {
    // Allow number/NaN handled by Object.is above; nothing else equal here
    return false;
  }
  // Circular reference handling
  if (seen.get(a) === b) return true;
  seen.set(a, b);

  const aIsDate = a instanceof Date;
  const bIsDate = b instanceof Date;
  if (aIsDate || bIsDate) return aIsDate && bIsDate && a.getTime() === b.getTime();

  const aIsRe = a instanceof RegExp;
  const bIsRe = b instanceof RegExp;
  if (aIsRe || bIsRe) return aIsRe && bIsRe && String(a) === String(b);

  if (typeof Buffer !== 'undefined') {
    const aIsBuf = Buffer.isBuffer(a);
    const bIsBuf = Buffer.isBuffer(b);
    if (aIsBuf || bIsBuf) return aIsBuf && bIsBuf && a.equals(b);
  }

  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i], seen)) return false;
    }
    return true;
  }

  const aIsSet = a instanceof Set;
  const bIsSet = b instanceof Set;
  if (aIsSet || bIsSet) {
    if (!(aIsSet && bIsSet) || a.size !== b.size) return false;
    // Reuse the SAME `seen` map (do not fork it) so structures that cycle
    // through a Set are still detected as visited and don't recurse forever.
    const bItems = [...b];
    const usedB = new Set();
    return [...a].every((item) => {
      const matchIdx = bItems.findIndex((other, i) => !usedB.has(i) && deepEqual(item, other, seen));
      if (matchIdx === -1) return false;
      usedB.add(matchIdx);
      return true;
    });
  }

  const aIsMap = a instanceof Map;
  const bIsMap = b instanceof Map;
  if (aIsMap || bIsMap) {
    if (!(aIsMap && bIsMap) || a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !deepEqual(v, b.get(k), seen)) return false;
    }
    return true;
  }

  if (typeof a === 'function' || typeof b === 'function') return a === b;

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(a[key], b[key], seen)) return false;
  }
  return true;
}

function errorMatches(err, expected) {
  const msg = err && err.message !== undefined ? String(err.message) : String(err);
  if (typeof expected === 'string') return msg.includes(expected);
  if (expected instanceof RegExp) return expected.test(msg);
  if (typeof expected === 'function') return err instanceof expected;
  return deepEqual(err, expected);
}

function getPath(obj, pathStr) {
  const parts = Array.isArray(pathStr) ? pathStr : String(pathStr).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return { found: false };
    if (!(p in Object(cur))) return { found: false };
    cur = cur[p];
  }
  return { found: true, value: cur };
}

function requireMock(actual, matcherName) {
  if (!actual || actual._isMockFunction !== true) {
    throw new AssertionError(
      `${matcherName}() can only be used on a mock function created with mock.fn() or mock.spyOn(); received ${fmt(actual)}`
    );
  }
}

function buildMatchers(actual, negated) {
  const check = (pass, positiveMsg, negativeMsg, details = {}) => {
    const ok = negated ? !pass : pass;
    if (!ok) {
      throw new AssertionError(negated ? negativeMsg : positiveMsg, details);
    }
    return true;
  };

  const matchers = {
    toBe(expected) {
      return check(
        Object.is(actual, expected),
        `expected ${fmt(actual)} to be ${fmt(expected)} (Object.is equality)`,
        `expected ${fmt(actual)} not to be ${fmt(expected)}`,
        { actual, expected, operator: 'toBe' }
      );
    },
    toEqual(expected) {
      return check(
        deepEqual(actual, expected),
        `expected ${fmt(actual)} to deeply equal ${fmt(expected)}`,
        `expected ${fmt(actual)} not to deeply equal ${fmt(expected)}`,
        { actual, expected, operator: 'toEqual' }
      );
    },
    toBeTruthy() {
      return check(!!actual, `expected ${fmt(actual)} to be truthy`, `expected ${fmt(actual)} not to be truthy`);
    },
    toBeFalsy() {
      return check(!actual, `expected ${fmt(actual)} to be falsy`, `expected ${fmt(actual)} not to be falsy`);
    },
    toBeNull() {
      return check(actual === null, `expected ${fmt(actual)} to be null`, `expected value not to be null`);
    },
    toBeUndefined() {
      return check(actual === undefined, `expected ${fmt(actual)} to be undefined`, `expected value not to be undefined`);
    },
    toBeDefined() {
      return check(actual !== undefined, `expected value to be defined, got undefined`, `expected value to be undefined`);
    },
    toBeNaN() {
      return check(Number.isNaN(actual), `expected ${fmt(actual)} to be NaN`, `expected value not to be NaN`);
    },
    toBeInstanceOf(ctor) {
      return check(
        actual instanceof ctor,
        `expected ${fmt(actual)} to be instance of ${ctor && ctor.name}`,
        `expected ${fmt(actual)} not to be instance of ${ctor && ctor.name}`
      );
    },
    toBeGreaterThan(n) {
      return check(actual > n, `expected ${fmt(actual)} > ${fmt(n)}`, `expected ${fmt(actual)} not > ${fmt(n)}`);
    },
    toBeGreaterThanOrEqual(n) {
      return check(actual >= n, `expected ${fmt(actual)} >= ${fmt(n)}`, `expected ${fmt(actual)} not >= ${fmt(n)}`);
    },
    toBeLessThan(n) {
      return check(actual < n, `expected ${fmt(actual)} < ${fmt(n)}`, `expected ${fmt(actual)} not < ${fmt(n)}`);
    },
    toBeLessThanOrEqual(n) {
      return check(actual <= n, `expected ${fmt(actual)} <= ${fmt(n)}`, `expected ${fmt(actual)} not <= ${fmt(n)}`);
    },
    toBeCloseTo(n, precision = 2) {
      const pass = Math.abs(actual - n) < Math.pow(10, -precision) / 2;
      return check(pass, `expected ${fmt(actual)} to be close to ${fmt(n)}`, `expected ${fmt(actual)} not to be close to ${fmt(n)}`);
    },
    toHaveLength(len) {
      const actualLen = actual == null ? undefined : actual.length;
      return check(
        actualLen === len,
        `expected length ${fmt(actualLen)} to be ${fmt(len)} for ${fmt(actual)}`,
        `expected length not to be ${fmt(len)}`
      );
    },
    toContain(item) {
      let pass = false;
      if (typeof actual === 'string') pass = actual.includes(item);
      else if (Array.isArray(actual)) pass = actual.some((v) => Object.is(v, item));
      else if (actual instanceof Set) pass = actual.has(item);
      else throw new AssertionError(`toContain() supports strings, arrays and sets; received ${fmt(actual)}`);
      return check(pass, `expected ${fmt(actual)} to contain ${fmt(item)}`, `expected ${fmt(actual)} not to contain ${fmt(item)}`);
    },
    toContainEqual(item) {
      const pass = Array.isArray(actual) && actual.some((v) => deepEqual(v, item));
      return check(pass, `expected ${fmt(actual)} to contain an element deeply equal to ${fmt(item)}`, `expected no element deeply equal to ${fmt(item)}`);
    },
    toMatch(pattern) {
      const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      return check(
        typeof actual === 'string' && re.test(actual),
        `expected ${fmt(actual)} to match ${fmt(pattern)}`,
        `expected ${fmt(actual)} not to match ${fmt(pattern)}`
      );
    },
    toHaveProperty(pathStr, value) {
      const res = getPath(actual, pathStr);
      let pass = res.found;
      if (pass && arguments.length >= 2) pass = deepEqual(res.value, value);
      return check(
        pass,
        `expected object to have property ${fmt(pathStr)}${arguments.length >= 2 ? ` with value ${fmt(value)} (got ${fmt(res.value)})` : ''}`,
        `expected object not to have property ${fmt(pathStr)}`
      );
    },
    toThrow(expected) {
      if (typeof actual !== 'function') {
        throw new AssertionError(`toThrow() expects a function; received ${fmt(actual)}`);
      }
      let threw = false;
      let err;
      try {
        actual();
      } catch (e) {
        threw = true;
        err = e;
      }
      let pass = threw;
      if (threw && expected !== undefined) pass = errorMatches(err, expected);
      return check(
        pass,
        expected === undefined
          ? `expected function to throw, but it did not`
          : `expected function to throw ${fmt(expected)}, ${threw ? `but it threw ${fmt(err && err.message ? err.message : err)}` : 'but it did not throw'}`,
        `expected function not to throw${expected !== undefined ? ` ${fmt(expected)}` : ''}, but it threw ${fmt(err && err.message ? err.message : err)}`
      );
    },
    toHaveBeenCalled() {
      requireMock(actual, 'toHaveBeenCalled');
      return check(
        actual.mock.calls.length > 0,
        `expected mock to have been called, but it was never called`,
        `expected mock not to have been called, but it was called ${actual.mock.calls.length} time(s)`
      );
    },
    toHaveBeenCalledTimes(n) {
      requireMock(actual, 'toHaveBeenCalledTimes');
      return check(
        actual.mock.calls.length === n,
        `expected mock to have been called ${n} time(s), but it was called ${actual.mock.calls.length} time(s)`,
        `expected mock not to have been called ${n} time(s)`
      );
    },
    toHaveBeenCalledWith(...args) {
      requireMock(actual, 'toHaveBeenCalledWith');
      const pass = actual.mock.calls.some((call) => deepEqual(call, args));
      return check(
        pass,
        `expected mock to have been called with ${fmt(args)}\nactual calls: ${fmt(actual.mock.calls.slice(-5))}`,
        `expected mock not to have been called with ${fmt(args)}`
      );
    },
    toHaveBeenLastCalledWith(...args) {
      requireMock(actual, 'toHaveBeenLastCalledWith');
      const last = actual.mock.calls[actual.mock.calls.length - 1];
      return check(
        last !== undefined && deepEqual(last, args),
        `expected last call to be ${fmt(args)}, got ${fmt(last)}`,
        `expected last call not to be ${fmt(args)}`
      );
    },
  };

  return matchers;
}

function asyncMatchers(subject, expectRejection) {
  const settle = async () => {
    const promise = typeof subject === 'function' ? Promise.resolve().then(subject) : subject;
    try {
      const value = await promise;
      return { rejected: false, value };
    } catch (err) {
      return { rejected: true, err };
    }
  };

  const makeSide = (negated) => {
    const proto = buildMatchers(undefined, false);
    const out = {};
    for (const name of Object.keys(proto)) {
      out[name] = async (...args) => {
        const result = await settle();
        if (expectRejection) {
          if (!result.rejected) {
            throw new AssertionError(`expected promise to reject, but it resolved with ${fmt(result.value)}`);
          }
          if (name === 'toThrow') {
            const pass = args.length === 0 ? true : errorMatches(result.err, args[0]);
            const ok = negated ? !pass : pass;
            if (!ok) {
              throw new AssertionError(
                `expected promise ${negated ? 'not ' : ''}to reject with ${fmt(args[0])}, but it rejected with ${fmt(result.err && result.err.message ? result.err.message : result.err)}`
              );
            }
            return true;
          }
          return buildMatchers(result.err, negated)[name](...args);
        }
        if (result.rejected) {
          throw new AssertionError(`expected promise to resolve, but it rejected with ${fmt(result.err && result.err.message ? result.err.message : result.err)}`);
        }
        return buildMatchers(result.value, negated)[name](...args);
      };
    }
    return out;
  };

  const side = makeSide(false);
  side.not = makeSide(true);
  return side;
}

function expect(actual) {
  const matchers = buildMatchers(actual, false);
  matchers.not = buildMatchers(actual, true);
  Object.defineProperty(matchers, 'resolves', {
    get() {
      return asyncMatchers(actual, false);
    },
  });
  Object.defineProperty(matchers, 'rejects', {
    get() {
      return asyncMatchers(actual, true);
    },
  });
  return matchers;
}

expect.fail = (message = 'expect.fail() was called') => {
  throw new AssertionError(message);
};

module.exports = { expect, deepEqual, AssertionError, fmt, errorMatches };
