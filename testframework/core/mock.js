'use strict';

/**
 * Sentinel Test Framework — Mock Engine
 *
 * - mock.fn()            : spy/stub functions with call recording
 * - mock.spyOn()         : patch a method on an object, restorable
 * - mock.autoStub()      : deep proxy stub — any method exists, is async,
 *                          and records its calls (used to stand in for
 *                          arbitrary dependencies like a Telegram bot)
 * - mock.FakeClock       : virtual time — patches Date/setTimeout/setInterval
 *                          so time-dependent logic (lockouts, polling loops)
 *                          is tested deterministically in milliseconds
 */

const activeSpies = [];

function fn(defaultImpl) {
  let impl = defaultImpl;
  const onceImpls = [];

  const mockFn = function (...args) {
    mockFn.mock.calls.push(args);
    mockFn.mock.instances.push(this);
    const chosen = onceImpls.length > 0 ? onceImpls.shift() : impl;
    try {
      const value = chosen ? chosen.apply(this, args) : undefined;
      mockFn.mock.results.push({ type: 'return', value });
      return value;
    } catch (err) {
      mockFn.mock.results.push({ type: 'throw', value: err });
      throw err;
    }
  };

  mockFn.mock = { calls: [], results: [], instances: [] };
  mockFn._isMockFunction = true;

  mockFn.mockImplementation = (f) => {
    impl = f;
    return mockFn;
  };
  mockFn.mockImplementationOnce = (f) => {
    onceImpls.push(f);
    return mockFn;
  };
  mockFn.mockReturnValue = (v) => mockFn.mockImplementation(() => v);
  mockFn.mockReturnValueOnce = (v) => mockFn.mockImplementationOnce(() => v);
  mockFn.mockResolvedValue = (v) => mockFn.mockImplementation(() => Promise.resolve(v));
  mockFn.mockResolvedValueOnce = (v) => mockFn.mockImplementationOnce(() => Promise.resolve(v));
  mockFn.mockRejectedValue = (e) => mockFn.mockImplementation(() => Promise.reject(e));
  mockFn.mockRejectedValueOnce = (e) => mockFn.mockImplementationOnce(() => Promise.reject(e));
  mockFn.mockClear = () => {
    mockFn.mock.calls.length = 0;
    mockFn.mock.results.length = 0;
    mockFn.mock.instances.length = 0;
    return mockFn;
  };
  mockFn.mockReset = () => {
    mockFn.mockClear();
    impl = undefined;
    onceImpls.length = 0;
    return mockFn;
  };
  mockFn.mockRestore = () => mockFn.mockReset();

  return mockFn;
}

function spyOn(obj, key) {
  if (!obj || typeof obj[key] !== 'function') {
    throw new TypeError(`spyOn: '${String(key)}' is not a function on the given object`);
  }
  const original = obj[key];
  const spy = fn(function (...args) {
    return original.apply(this, args);
  });
  spy.mockRestore = () => {
    obj[key] = original;
  };
  obj[key] = spy;
  activeSpies.push(spy);
  return spy;
}

function restoreAllMocks() {
  while (activeSpies.length) {
    const spy = activeSpies.pop();
    try {
      spy.mockRestore();
    } catch (e) {
      /* already restored */
    }
  }
}

/**
 * Deep stub: every property access returns a recording async mock function.
 * `stub.__calls` exposes the full ordered call log across all methods.
 */
function autoStub(name = 'stub', sharedLog = null) {
  const calls = sharedLog || [];
  const cache = new Map();
  const target = function () {};

  return new Proxy(target, {
    get(t, prop) {
      if (prop === '__calls') return calls;
      if (prop === '__isAutoStub') return true;
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'toString') return () => `[autoStub ${name}]`;
      if (!cache.has(prop)) {
        const method = fn(async (...args) => {
          calls.push({ method: `${name}.${String(prop)}`, args });
          return undefined;
        });
        cache.set(prop, method);
      }
      return cache.get(prop);
    },
    apply(t, thisArg, args) {
      calls.push({ method: name, args });
      return Promise.resolve(undefined);
    },
  });
}

/* ------------------------------------------------------------------ */
/* Virtual time                                                        */
/* ------------------------------------------------------------------ */

const RealDate = Date;
const realTimers = {
  setTimeout: global.setTimeout,
  setInterval: global.setInterval,
  clearTimeout: global.clearTimeout,
  clearInterval: global.clearInterval,
  setImmediate: global.setImmediate,
};

class FakeClock {
  constructor({ now = 1700000000000 } = {}) {
    this.now = now;
    this.timers = new Map();
    this.nextId = 1;
    this.installed = false;

    // Bound implementations, usable directly (e.g. injected into a sandbox)
    // without patching globals.
    this.fns = {
      setTimeout: (cb, delay = 0, ...args) => this._schedule(cb, delay, args, null),
      setInterval: (cb, delay = 0, ...args) => this._schedule(cb, delay, args, Math.max(1, delay)),
      clearTimeout: (id) => this.timers.delete(id),
      clearInterval: (id) => this.timers.delete(id),
      setImmediate: (cb, ...args) => this._schedule(cb, 0, args, null),
      Date: this._makeDateClass(),
    };
  }

  _makeDateClass() {
    const clock = this;
    class FakeDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(clock.now);
        else super(...args);
      }
      static now() {
        return clock.now;
      }
    }
    return FakeDate;
  }

  _schedule(callback, delay, args, interval) {
    const id = this.nextId++;
    this.timers.set(id, {
      id,
      callback,
      args,
      time: this.now + Math.max(0, Number(delay) || 0),
      interval,
    });
    return id;
  }

  _nextDue(limit) {
    let next = null;
    for (const timer of this.timers.values()) {
      if (timer.time <= limit && (next === null || timer.time < next.time || (timer.time === next.time && timer.id < next.id))) {
        next = timer;
      }
    }
    return next;
  }

  /** Advance virtual time, firing due timers synchronously. */
  tick(ms) {
    const end = this.now + ms;
    for (;;) {
      const timer = this._nextDue(end);
      if (!timer) break;
      this.now = Math.max(this.now, timer.time);
      if (timer.interval !== null) timer.time += timer.interval;
      else this.timers.delete(timer.id);
      timer.callback(...timer.args);
    }
    this.now = end;
  }

  /**
   * Advance virtual time, draining the microtask queue between timer
   * callbacks so async callbacks (awaiting stubs) settle deterministically.
   */
  async tickAsync(ms) {
    const end = this.now + ms;
    for (;;) {
      const timer = this._nextDue(end);
      if (!timer) break;
      this.now = Math.max(this.now, timer.time);
      if (timer.interval !== null) timer.time += timer.interval;
      else this.timers.delete(timer.id);
      await timer.callback(...timer.args);
      await new Promise((resolve) => realTimers.setImmediate(resolve));
    }
    this.now = end;
  }

  get pendingTimerCount() {
    return this.timers.size;
  }

  /** Patch the real globals (Date, setTimeout, ...) with this clock. */
  install() {
    if (this.installed) return this;
    this.installed = true;
    global.Date = this.fns.Date;
    global.setTimeout = this.fns.setTimeout;
    global.setInterval = this.fns.setInterval;
    global.clearTimeout = this.fns.clearTimeout;
    global.clearInterval = this.fns.clearInterval;
    return this;
  }

  uninstall() {
    if (!this.installed) return this;
    this.installed = false;
    global.Date = RealDate;
    global.setTimeout = realTimers.setTimeout;
    global.setInterval = realTimers.setInterval;
    global.clearTimeout = realTimers.clearTimeout;
    global.clearInterval = realTimers.clearInterval;
    return this;
  }
}

/** Flush pending microtasks + one macrotask turn (real timers). */
function drain() {
  return new Promise((resolve) => realTimers.setImmediate(resolve));
}

module.exports = { fn, spyOn, restoreAllMocks, autoStub, FakeClock, drain, RealDate };
