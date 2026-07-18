'use strict';

/**
 * Resilience primitives: retry with exponential backoff, circuit breaker,
 * and a token-bucket rate limiter. Clocks/sleeps are injectable so the
 * behavior is fully unit-testable without real waiting.
 */

const defaultSleep = (ms) => new Promise(res => setTimeout(res, ms));

/**
 * Retries an async fn with exponential backoff + optional jitter.
 */
async function retry(fn, options = {}) {
    const {
        attempts = 3,
        baseDelayMs = 200,
        maxDelayMs = 10000,
        factor = 2,
        jitter = true,
        isRetryable = () => true,
        sleep = defaultSleep,
        onRetry = () => {}
    } = options;

    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fn(attempt);
        } catch (err) {
            lastError = err;
            if (attempt === attempts || !isRetryable(err)) throw err;
            let delay = Math.min(baseDelayMs * Math.pow(factor, attempt - 1), maxDelayMs);
            if (jitter) delay = delay / 2 + Math.random() * (delay / 2);
            onRetry(err, attempt, delay);
            await sleep(delay);
        }
    }
    throw lastError;
}

/**
 * Circuit breaker: closed -> open after N consecutive failures,
 * open -> half-open after resetTimeoutMs, half-open -> closed on success.
 */
class CircuitBreaker {
    constructor(options = {}) {
        this.failureThreshold = options.failureThreshold || 5;
        this.resetTimeoutMs = options.resetTimeoutMs || 30000;
        this.now = options.now || (() => Date.now());
        this.state = 'closed';
        this.failures = 0;
        this.openedAt = null;
    }

    getState() {
        if (this.state === 'open' && this.now() - this.openedAt >= this.resetTimeoutMs) {
            this.state = 'half-open';
        }
        return this.state;
    }

    async execute(fn) {
        const state = this.getState();
        if (state === 'open') {
            const err = new Error('Circuit breaker is open');
            err.code = 'CIRCUIT_OPEN';
            throw err;
        }
        try {
            const result = await fn();
            this.failures = 0;
            this.state = 'closed';
            return result;
        } catch (err) {
            this.failures += 1;
            if (state === 'half-open' || this.failures >= this.failureThreshold) {
                this.state = 'open';
                this.openedAt = this.now();
            }
            throw err;
        }
    }
}

/**
 * Token-bucket rate limiter.
 */
class RateLimiter {
    constructor(options = {}) {
        this.capacity = options.capacity || 10;
        this.refillPerSecond = options.refillPerSecond || 1;
        this.now = options.now || (() => Date.now());
        this.tokens = this.capacity;
        this.lastRefill = this.now();
    }

    refill() {
        const elapsed = (this.now() - this.lastRefill) / 1000;
        this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
        this.lastRefill = this.now();
    }

    tryAcquire(count = 1) {
        this.refill();
        if (this.tokens >= count) {
            this.tokens -= count;
            return true;
        }
        return false;
    }
}

module.exports = { retry, CircuitBreaker, RateLimiter };
