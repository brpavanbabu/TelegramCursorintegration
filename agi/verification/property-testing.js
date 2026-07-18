'use strict';

/**
 * Property-Based Testing engine — falsifies behavioral invariants instead of
 * asserting hardcoded examples. Uses a seeded PRNG for reproducibility and
 * greedy shrinking so failures come back as the *simplest* counterexample.
 */

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const gen = {
    int(min = -1000, max = 1000) {
        const g = (rng) => min + Math.floor(rng() * (max - min + 1));
        g.shrink = (v) => [...new Set([
            Math.max(min, Math.min(max, 0)),
            Math.trunc(v / 2),
            v - Math.sign(v)
        ])].filter(c => c !== v && c >= min && c <= max);
        return g;
    },
    bool() {
        const g = (rng) => rng() < 0.5;
        g.shrink = (v) => (v ? [false] : []);
        return g;
    },
    string(maxLen = 20) {
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 !@#\'"\\<>{}';
        const g = (rng) => {
            const len = Math.floor(rng() * (maxLen + 1));
            let s = '';
            for (let i = 0; i < len; i++) s += chars[Math.floor(rng() * chars.length)];
            return s;
        };
        g.shrink = (v) => (v.length ? [...new Set(['', v.slice(0, Math.floor(v.length / 2)), v.slice(1)])].filter(c => c !== v) : []);
        return g;
    },
    array(itemGen, maxLen = 10) {
        const g = (rng) => {
            const len = Math.floor(rng() * (maxLen + 1));
            return Array.from({ length: len }, () => itemGen(rng));
        };
        g.shrink = (v) => {
            if (!v.length) return [];
            const out = [[], v.slice(0, Math.floor(v.length / 2)), v.slice(1)];
            return out.filter(c => c.length !== v.length);
        };
        return g;
    },
    oneOf(values) {
        const g = (rng) => values[Math.floor(rng() * values.length)];
        g.shrink = () => [];
        return g;
    }
};

function holds(property, args) {
    try {
        return property(...args) !== false;
    } catch (err) {
        return false;
    }
}

/** Greedily shrinks one argument at a time while the property still fails. */
function shrinkCounterexample(generators, property, args, maxRounds = 200) {
    let current = [...args];
    for (let round = 0; round < maxRounds; round++) {
        let improved = false;
        for (let i = 0; i < current.length; i++) {
            const shrinker = generators[i].shrink;
            if (!shrinker) continue;
            for (const candidate of shrinker(current[i])) {
                const attempt = [...current];
                attempt[i] = candidate;
                if (!holds(property, attempt)) {
                    current = attempt;
                    improved = true;
                    break;
                }
            }
        }
        if (!improved) break;
    }
    return current;
}

/**
 * @param {Array<function>} generators one per property argument
 * @param {function} property (...args) => boolean (false/throw = falsified)
 * @param {object} [options] { runs = 200, seed = 42 }
 * @returns {{ok: boolean, runs: number, counterexample: any[]|null, error: string|null}}
 */
function forAll(generators, property, options = {}) {
    const { runs = 200, seed = 42 } = options;
    const rng = mulberry32(seed);
    for (let run = 1; run <= runs; run++) {
        const args = generators.map(g => g(rng));
        if (!holds(property, args)) {
            let error = null;
            try { property(...args); } catch (err) { error = err.message; }
            return {
                ok: false,
                runs: run,
                counterexample: shrinkCounterexample(generators, property, args),
                error
            };
        }
    }
    return { ok: true, runs, counterexample: null, error: null };
}

module.exports = { forAll, gen, mulberry32 };
